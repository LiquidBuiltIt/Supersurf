/**
 * WebSocket bridge to the Chrome extension.
 *
 * Runs an HTTP + WebSocket server on localhost (default port 5555).
 * Communication uses JSON-RPC 2.0 with correlation IDs for request/response matching.
 *
 * Key behaviors:
 *   - Single-connection model: rejects additional browsers while one is connected
 *   - 10s keep-alive pings to detect stale connections
 *   - 30s default timeout on `sendCmd` requests
 *   - Handles three message types: responses (correlated by id), handshakes (browser info),
 *     and notifications (tab info updates)
 *   - `onRawConnection` hook for multiplexer to intercept connections before default handling
 *
 * @module bridge
 * @exports IExtensionTransport - Interface for the transport layer
 * @exports ExtensionServer - Concrete WebSocket implementation
 */

import crypto from 'crypto';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createLog } from './logger';

const log = createLog('[WS]');

/** Transport interface abstracting the WebSocket connection to the Chrome extension. */
export interface IExtensionTransport {
  sendCmd(method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
  readonly connected: boolean;
  readonly browser: string;
  readonly buildTime: string | null;
  onReconnect: (() => void) | null;
  onTabInfoUpdate: ((tabInfo: any) => void) | null;
  notifyClientId(clientId: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Pending request awaiting a JSON-RPC response from the extension. */
interface InflightRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * WebSocket server that bridges the MCP server to the Chrome extension.
 * Manages a single active connection, with reconnection support.
 */
export class ExtensionServer implements IExtensionTransport {
  private port: number;
  private host: string;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private inflight: Map<string, InflightRequest> = new Map();
  private browserType: string = 'chrome';
  private buildTimestamp: string | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  onReconnect: (() => void) | null = null;
  onTabInfoUpdate: ((tabInfo: any) => void) | null = null;
  onRawConnection: ((ws: WebSocket, request: http.IncomingMessage) => boolean) | null = null;

  constructor(port: number = 5555, host: string = '127.0.0.1') {
    this.port = port;
    this.host = host;
  }

  get browser(): string {
    return this.browserType;
  }

  get buildTime(): string | null {
    return this.buildTimestamp;
  }

  get connected(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  /** Spin up the HTTP + WebSocket server and begin accepting connections. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('SuperSurf Extension Server');
      });

      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('error', (error) => {
        log('WebSocketServer error:', error);
        reject(error);
      });

      this.wss.on('connection', (ws, request) => {
        log('Extension connection attempt');

        // Delegate to raw connection handler if set (used by multiplexer)
        if (this.onRawConnection) {
          const handled = this.onRawConnection(ws, request);
          if (handled) return;
        }

        // Reject if already connected
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          log('Rejecting new connection — browser already connected');
          const errorMsg = {
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Another browser is already connected. Only one browser at a time.',
            },
          };
          ws.send(JSON.stringify(errorMsg));
          setTimeout(() => ws.close(1008, 'Already connected'), 100);
          return;
        }

        log('Extension connected');
        const isReconnection = !!this.socket;

        if (this.socket) {
          log('Closing previous connection — reconnection detected');
          this.socket.close();
        }

        this.socket = ws;

        // Clear old ping interval
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }

        // Keep-alive ping every 10s
        this.pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        }, 10000);

        if (isReconnection && this.onReconnect) {
          this.onReconnect();
        }

        ws.on('message', (data) => this.handleMessage(data));
        ws.on('pong', () => log('Pong received'));
        ws.on('close', () => {
          log('Extension disconnected');
          if (this.socket === ws) {
            this.socket = null;
          }
          if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
          }
          this.drainInflight();
        });
        ws.on('error', (error) => log('WebSocket error:', error));
      });

      this.httpServer.on('error', (error) => {
        log('HTTP Server error:', error);
        reject(error);
      });

      this.httpServer.listen(this.port, this.host, () => {
        log(`Server listening on ${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  /** Route incoming WebSocket messages: responses, handshakes, or notifications. */
  private handleMessage(data: any): void {
    try {
      const message = JSON.parse(data.toString());

      // JSON-RPC response — correlate with inflight request by id
      if (message.id !== undefined && !message.method) {
        const pending = this.inflight.get(message.id);
        if (pending) {
          this.inflight.delete(message.id);

          // Piggyback: extract tab info from response if present
          const result = message.result;
          if (result && typeof result === 'object' && 'currentTab' in result && this.onTabInfoUpdate) {
            this.onTabInfoUpdate(result.currentTab);
          }

          if (message.error) {
            pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
          } else {
            pending.resolve(message.result);
          }
        }
        return;
      }

      // Handshake
      if (message.type === 'handshake') {
        log('Handshake received:', message);
        this.browserType = message.browser || 'chrome';
        this.buildTimestamp = message.buildTimestamp || null;
        return;
      }

      // Notification (has method, no id)
      if (message.method && message.id === undefined) {
        log('Notification:', message.method);
        if (
          message.method === 'notifications/tab_info_update' &&
          message.params?.currentTab &&
          this.onTabInfoUpdate
        ) {
          this.onTabInfoUpdate(message.params.currentTab);
        }
        return;
      }
    } catch (error) {
      log('Error handling message:', error);
    }
  }

  /**
   * Send a JSON-RPC 2.0 request to the extension and await the response.
   * @param method - Command name (e.g., 'evaluateScript', 'forwardCDPCommand')
   * @param params - Command parameters
   * @param timeout - Max wait time in ms (default 30s)
   * @throws If extension is disconnected or request times out
   */
  async sendCmd(method: string, params: Record<string, unknown> = {}, timeout: number = 30000): Promise<any> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Extension not connected. Open the extension popup and click "Enable".');
    }

    const id = crypto.randomUUID().slice(0, 8);

    // Log outgoing command with params
    if (method === 'forwardCDPCommand') {
      log(`→ ${method}:`, (params as any).method, (params as any).params ?? {});
    } else {
      log(`→ ${method}`, params);
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.inflight.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this.inflight.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          log(`← ${method}`, result);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          log(`✗ ${method}:`, error.message);
          reject(error);
        },
      });

      const message = { jsonrpc: '2.0', id, method, params };
      this.socket!.send(JSON.stringify(message));
    });
  }

  /** Send an `authenticated` notification to the extension with the session's client ID. */
  notifyClientId(clientId: string): void {
    log('Client ID set to:', clientId);
    if (this.connected) {
      const notification = {
        jsonrpc: '2.0',
        method: 'authenticated',
        params: { client_id: clientId },
      };
      this.socket!.send(JSON.stringify(notification));
    }
  }

  /** Reject all pending requests with a disconnect error and clear the inflight map. */
  private drainInflight(): void {
    if (this.inflight.size === 0) return;
    log(`Draining ${this.inflight.size} inflight request(s)`);
    for (const [_id, pending] of this.inflight) {
      pending.reject(new Error('Extension disconnected'));
    }
    this.inflight.clear();
  }

  /** Gracefully shut down: clear ping interval, close socket, close servers. */
  async stop(): Promise<void> {
    log('Stopping server');

    this.drainInflight();

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => {
          log('Server stopped');
          resolve();
        });
      });
    }
  }
}
