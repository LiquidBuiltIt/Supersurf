/**
 * WebSocket bridge to Chrome extension(s).
 *
 * Runs an HTTP + WebSocket server on localhost (default port 5555).
 * Communication uses JSON-RPC 2.0 with correlation IDs for request/response matching.
 *
 * Supports multiple concurrent extension connections via the Matchmaker connection
 * pool. Connections without a profile field are treated as unmanaged (the "bring your
 * own Chromium" path).
 *
 * @module extension-bridge
 */

import crypto from 'crypto';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { FileLogger } from 'shared';
import { Matchmaker } from './profiles/matchmaker';
import type { PooledConnection } from './profiles/types';

const debugLog = (...args: unknown[]) => {
  const logger = (global as any).DAEMON_LOGGER as FileLogger | undefined;
  if (logger) logger.log('[WS]', ...args);
  else if ((global as any).DAEMON_DEBUG) console.error('[WS]', ...args);
};

/** Registration HTML template served at /register/:name. */
function registrationHtml(profileName: string): string {
  return `<html>
<head><title>Registering Profile...</title></head>
<body>
<p>Registering profile "${profileName}"... This tab will close automatically.</p>
<script>
  window.postMessage({ __supersurf: true, action: 'register-profile', profile: '${profileName}' }, '*');
</script>
</body>
</html>`;
}

/**
 * WebSocket server that bridges the daemon to Chrome extension(s).
 * Routes connections via the Matchmaker pool; unmanaged connections (no profile) are supported.
 */
export class ExtensionBridge {
  private port: number;
  private host: string;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;

  /** Connection pool and profile-based routing. */
  matchmaker: Matchmaker;

  onTabInfoUpdate: ((tabInfo: any) => void) | null = null;

  constructor(port: number = 5555, host: string = '127.0.0.1') {
    this.port = port;
    this.host = host;
    this.matchmaker = new Matchmaker();
  }

  /** Browser name from the first available connection (backwards compat). */
  get browser(): string {
    for (const conn of this.matchmaker['pool'].values()) {
      if (conn.ws.readyState === WebSocket.OPEN) return conn.browser;
    }
    return 'chrome';
  }

  /** Build timestamp from the first available connection (backwards compat). */
  get buildTime(): string | null {
    for (const conn of this.matchmaker['pool'].values()) {
      if (conn.ws.readyState === WebSocket.OPEN) return conn.buildTimestamp;
    }
    return null;
  }

  /** True if at least one extension is connected. */
  get connected(): boolean {
    return this.matchmaker.hasConnections;
  }

  /** Spin up the HTTP + WebSocket server and begin accepting connections. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        if (req.url) {
          const match = req.url.match(/^\/register\/([a-z0-9][a-z0-9-]*)$/);
          if (match) {
            const profileName = match[1];
            debugLog(`Serving registration page for profile: ${profileName}`);
            res.writeHead(200, {
              'Content-Type': 'text/html',
              'Set-Cookie': `supersurf_profile=${profileName}; Path=/; SameSite=Lax`,
            });
            res.end(registrationHtml(profileName));
            return;
          }
        }
        res.writeHead(200);
        res.end('SuperSurf Daemon');
      });

      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('error', (error) => {
        debugLog('WebSocketServer error:', error);
        reject(error);
      });

      this.wss.on('connection', (ws, req) => {
        debugLog('Extension connection attempt');

        // Extract profile from cookie on the upgrade request (survives extension removal)
        let cookieProfile: string | null = null;
        const cookieHeader = req.headers.cookie;
        if (cookieHeader) {
          const match = cookieHeader.match(/(?:^|;\s*)supersurf_profile=([a-z0-9][a-z0-9-]*)/);
          if (match) {
            cookieProfile = match[1];
            debugLog(`Profile from cookie: ${cookieProfile}`);
          }
        }

        // Create pooled connection entry
        const conn: PooledConnection = {
          ws,
          profile: cookieProfile,
          browser: 'chrome',
          buildTimestamp: null,
          pingInterval: null,
          inflight: new Map(),
        };

        // Keep-alive ping every 10s
        conn.pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        }, 10000);

        // Add to pool
        this.matchmaker.addConnection(ws, conn);

        debugLog('Extension connected');

        ws.on('message', (data) => this.handleMessage(ws, conn, data));
        ws.on('pong', () => debugLog('Pong received'));
        ws.on('close', () => {
          debugLog('Extension disconnected');
          this.matchmaker.removeConnection(ws);
        });
        ws.on('error', (error) => debugLog('WebSocket error:', error));
      });

      this.httpServer.on('error', (error) => {
        debugLog('HTTP Server error:', error);
        reject(error);
      });

      this.httpServer.listen(this.port, this.host, () => {
        debugLog(`Server listening on ${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  /** Route incoming WebSocket messages for a specific connection. */
  private handleMessage(ws: WebSocket, conn: PooledConnection, data: any): void {
    try {
      const message = JSON.parse(data.toString());

      // JSON-RPC response — correlate with connection's inflight map
      if (message.id !== undefined && !message.method) {
        const pending = conn.inflight.get(message.id);
        if (pending) {
          conn.inflight.delete(message.id);

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
        debugLog('Handshake received:', message);
        conn.browser = message.browser || 'chrome';
        conn.buildTimestamp = message.buildTimestamp || null;

        // Profile field in handshake (subsequent launches)
        if (message.profile) {
          this.matchmaker.updateProfile(ws, message.profile);
        }

        return;
      }

      // Profile announcement notification (first launch, after registration)
      if (message.method === 'profile_announce' && message.params?.profile) {
        debugLog('Profile announcement:', message.params.profile);
        this.matchmaker.updateProfile(ws, message.params.profile);
        return;
      }

      // Tab info notification
      if (message.method && message.id === undefined) {
        debugLog('Notification:', message.method);
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
      debugLog('Error handling message:', error);
    }
  }

  /**
   * Send a JSON-RPC 2.0 request to the unmanaged extension connection.
   * Backwards-compatible with v1 — delegates to matchmaker for the unmanaged connection.
   */
  async sendCmd(method: string, params: Record<string, unknown> = {}, timeout: number = 30000): Promise<any> {
    const conn = this.matchmaker.getConnectionForProfile(null);
    if (!conn) {
      throw new Error('Extension not connected');
    }
    return this.matchmaker.sendCmd(conn, method, params, timeout);
  }

  /**
   * Send a JSON-RPC 2.0 request to a specific profile's extension connection.
   */
  async sendCmdToProfile(profile: string, method: string, params: Record<string, unknown> = {}, timeout: number = 30000): Promise<any> {
    const conn = this.matchmaker.getConnectionForProfile(profile);
    if (!conn) {
      throw new Error(`No extension connected for profile "${profile}"`);
    }
    return this.matchmaker.sendCmd(conn, method, params, timeout);
  }

  /** Send an `authenticated` notification to the extension with a session's client ID. */
  notifyClientId(clientId: string): void {
    debugLog('Client ID set to:', clientId);
    // Send to unmanaged connection (backwards compat)
    const conn = this.matchmaker.getConnectionForProfile(null);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      const notification = {
        jsonrpc: '2.0',
        method: 'authenticated',
        params: { client_id: clientId },
      };
      conn.ws.send(JSON.stringify(notification));
    }
  }

  /** Gracefully shut down: close all connections, close servers. */
  async stop(): Promise<void> {
    debugLog('Stopping server');

    this.matchmaker.shutdown();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => {
          debugLog('Server stopped');
          resolve();
        });
      });
    }
  }
}
