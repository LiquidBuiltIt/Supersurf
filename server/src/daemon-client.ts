/**
 * DaemonClient — IExtensionTransport implementation over Unix domain socket.
 *
 * Connects to the daemon's IPC server, performs session handshake, and
 * routes JSON-RPC 2.0 tool calls through the daemon to the extension.
 *
 * @module daemon-client
 * @exports DaemonClient
 */

import net from 'net';
import crypto from 'crypto';
import type { IExtensionTransport } from './bridge';
import { createLog } from './logger';

const log = createLog('[Daemon]');

/** Pending request awaiting a JSON-RPC response from the daemon. */
interface InflightRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * Transport that connects to the SuperSurf daemon over a Unix domain socket.
 * Implements IExtensionTransport for drop-in replacement of ExtensionServer.
 */
export class DaemonClient implements IExtensionTransport {
  private sockPath: string;
  private sessionId: string;
  private socket: net.Socket | null = null;
  private inflight: Map<string, InflightRequest> = new Map();
  private buffer: string = '';
  private _connected: boolean = false;
  private _browser: string = 'chrome';
  private _buildTime: string | null = null;

  onReconnect: (() => void) | null = null;
  onTabInfoUpdate: ((tabInfo: any) => void) | null = null;

  constructor(sockPath: string, sessionId: string) {
    this.sockPath = sockPath;
    this.sessionId = sessionId;
  }

  get connected(): boolean {
    return this._connected;
  }

  get browser(): string {
    return this._browser;
  }

  get buildTime(): string | null {
    return this._buildTime;
  }

  /**
   * Connect to the daemon, send session_register handshake, await session_ack.
   * Resolves when the session is established and browser info is available.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      log('Connecting to daemon at', this.sockPath);

      this.socket = net.createConnection(this.sockPath);

      const connectTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error('Timeout connecting to daemon'));
      }, 10000);

      this.socket.on('connect', () => {
        log('Connected to daemon socket');
        // Send handshake
        this.sendLine({
          type: 'session_register',
          sessionId: this.sessionId,
        });
      });

      this.socket.on('data', (data) => {
        this.buffer += data.toString();

        let newlineIdx: number;
        while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, newlineIdx).trim();
          this.buffer = this.buffer.slice(newlineIdx + 1);

          if (!line) continue;

          try {
            const msg = JSON.parse(line);

            // Handshake responses
            if (msg.type === 'session_ack') {
              clearTimeout(connectTimeout);
              this._browser = msg.browser || 'chrome';
              this._buildTime = msg.buildTimestamp || null;
              this._connected = true;
              log(`Session registered: "${this.sessionId}", browser: ${this._browser}`);
              resolve();
              continue;
            }

            if (msg.type === 'session_reject') {
              clearTimeout(connectTimeout);
              reject(new Error(msg.reason || 'Session rejected by daemon'));
              return;
            }

            // JSON-RPC responses
            if (msg.jsonrpc === '2.0' && msg.id !== undefined) {
              const pending = this.inflight.get(String(msg.id));
              if (pending) {
                this.inflight.delete(String(msg.id));
                if (msg.error) {
                  pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                } else {
                  // Piggyback: extract tab info from response if present
                  const result = msg.result;
                  if (result && typeof result === 'object' && 'currentTab' in result && this.onTabInfoUpdate) {
                    this.onTabInfoUpdate(result.currentTab);
                  }
                  pending.resolve(msg.result);
                }
              }
            }
          } catch (err: any) {
            log('Parse error from daemon:', err.message);
          }
        }
      });

      this.socket.on('close', () => {
        log('Daemon connection closed');
        this._connected = false;
        this.drainInflight();
      });

      this.socket.on('error', (error: any) => {
        log('Daemon socket error:', error.message);
        if (!this._connected) {
          clearTimeout(connectTimeout);
          reject(error);
        }
      });
    });
  }

  /**
   * Send a JSON-RPC 2.0 request to the daemon and await the response.
   */
  async sendCmd(method: string, params: Record<string, unknown> = {}, timeout: number = 60000): Promise<any> {
    if (!this.socket || !this._connected) {
      throw new Error('Not connected to daemon. Call connect first.');
    }

    const id = crypto.randomUUID().slice(0, 8);

    log(`-> ${method}`, params);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.inflight.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this.inflight.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          log(`<- ${method}`, result);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          log(`x ${method}:`, error.message);
          reject(error);
        },
      });

      this.sendLine({ jsonrpc: '2.0', id, method, params, timeout });
    });
  }

  /** No-op — daemon handles extension auth. */
  notifyClientId(_clientId: string): void {
    // Daemon manages the extension connection directly
  }

  /** Close the Unix socket connection. Daemon stays alive for other sessions. */
  async stop(): Promise<void> {
    log('Disconnecting from daemon');
    this.drainInflight();
    this.cleanup();
    this._connected = false;
  }

  /** Write an NDJSON line to the daemon socket. */
  private sendLine(data: any): void {
    if (this.socket && this.socket.writable) {
      this.socket.write(JSON.stringify(data) + '\n');
    }
  }

  /** Reject all pending requests. */
  private drainInflight(): void {
    if (this.inflight.size === 0) return;
    log(`Draining ${this.inflight.size} inflight request(s)`);
    for (const [, pending] of this.inflight) {
      pending.reject(new Error('Daemon connection closed'));
    }
    this.inflight.clear();
  }

  /** Clean up socket resources. */
  private cleanup(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = '';
  }
}
