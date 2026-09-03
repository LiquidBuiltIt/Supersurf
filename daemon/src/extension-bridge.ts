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
import { applyKeepBrowserPreference } from './profiles/keep-browser';
import { applyHandshakeVersion } from './profiles/extension-version';
import { registrationHtml } from './profiles/registration-page';
import type { PooledConnection } from './profiles/types';

const debugLog = (...args: unknown[]) => {
  const logger = (global as any).DAEMON_LOGGER as FileLogger | undefined;
  if (logger) logger.log('[WS]', ...args);
  else if ((global as any).DAEMON_DEBUG) console.error('[WS]', ...args);
};

/**
 * How long a pooled connection may stay unchecked before it is allowed through
 * anyway. The Matchmaker will not hand out a 'pending' connection, so without
 * this deadline a client that connects and never handshakes would wedge its
 * slot for the full match window. Fails open by design.
 */
const HANDSHAKE_DEADLINE_MS = 5000;

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

  private daemonVersion: string;

  constructor(port: number = 5555, host: string = '127.0.0.1', daemonVersion: string = 'unknown') {
    this.port = port;
    this.host = host;
    this.daemonVersion = daemonVersion;
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

  /**
   * The most recent extension version rejection, or null. Rides session_ack so
   * an agent calling `connect` without a profile learns immediately, rather
   * than discovering it as a silent absence of browser tools.
   */
  get extensionVersionError(): string | null {
    return this.matchmaker.lastVersionRejection?.message ?? null;
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
          keepBrowserOnSessionEnd: false,
          version: null,
          versionStatus: 'pending',
          versionError: null,
        };

        // Keep-alive ping every 10s
        conn.pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        }, 10000);

        // Bounded wait for the handshake. A connection is pooled before its
        // handshake arrives, and the Matchmaker will not hand out an unchecked
        // one — so a silent client must not be able to hold its slot forever.
        const handshakeDeadline = setTimeout(() => {
          if (conn.versionStatus !== 'pending') return;
          const slot = conn.profile || 'unmanaged';
          debugLog(`No handshake within ${HANDSHAKE_DEADLINE_MS}ms (${slot}) — allowing connection unchecked`);
          conn.versionStatus = 'warn';
          conn.versionError =
            'The connected extension never sent a handshake, so its version was not checked.';
          console.error(
            `SuperSurf: extension version guard inactive for "${slot}" — the connected extension ` +
            `never sent a handshake within ${HANDSHAKE_DEADLINE_MS}ms, so its version was not checked.`,
          );
          this.matchmaker.tryResolvePendingMatches();
        }, HANDSHAKE_DEADLINE_MS);

        // Add to pool
        this.matchmaker.addConnection(ws, conn);

        debugLog('Extension connected');

        ws.on('message', (data) => this.handleMessage(ws, conn, data, handshakeDeadline));
        ws.on('pong', () => debugLog('Pong received'));
        ws.on('close', () => {
          debugLog('Extension disconnected');
          clearTimeout(handshakeDeadline);
          this.matchmaker.removeConnection(ws);
        });
        ws.on('error', (error) => {
          clearTimeout(handshakeDeadline);
          debugLog('WebSocket error:', error);
        });
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
  private handleMessage(
    ws: WebSocket,
    conn: PooledConnection,
    data: any,
    handshakeDeadline: ReturnType<typeof setTimeout>,
  ): void {
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
        clearTimeout(handshakeDeadline);
        conn.browser = message.browser || 'chrome';
        conn.buildTimestamp = message.buildTimestamp || null;
        applyKeepBrowserPreference(conn, message.keepBrowserOnSessionEnd);

        // Version check before anything else touches the pool. On rejection
        // this fails any waiting agent by name and closes the socket, so the
        // profile update below must not run — it would re-enter the pending
        // match resolver for a connection that is already unusable.
        const verdict = applyHandshakeVersion(conn, message, this.daemonVersion, this.matchmaker);
        if (verdict.status === 'rejected') {
          debugLog(`Extension rejected: ${verdict.message}`);
          return;
        }
        if (verdict.status === 'warn' && verdict.message) {
          debugLog(`Extension version warning: ${verdict.message}`);
          if (!verdict.guardActive) {
            // The version check did not run at all for this connection. A guard
            // that is silently off reads as a guard that passed, so this goes to
            // stderr — the surface a user actually sees from `supersurf daemon`.
            console.error(`SuperSurf: extension version guard inactive — ${verdict.message}`);
          }
        }

        // Profile field in handshake (subsequent launches)
        if (typeof message.profile === 'string' && message.profile) {
          this.matchmaker.updateProfile(ws, message.profile);
        } else {
          // The version check may have promoted this connection out of
          // 'pending'; give any queued match a chance at it.
          this.matchmaker.tryResolvePendingMatches();
        }

        return;
      }

      // Profile announcement notification (first launch, after registration)
      if (message.method === 'profile_announce' && message.params?.profile) {
        debugLog('Profile announcement:', message.params.profile);
        this.matchmaker.updateProfile(ws, message.params.profile);
        return;
      }

      if (message.method === 'session/keep_browser') {
        applyKeepBrowserPreference(conn, message.params?.keepBrowserOnSessionEnd);
        debugLog('keepBrowserOnSessionEnd updated:', conn.keepBrowserOnSessionEnd);
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
