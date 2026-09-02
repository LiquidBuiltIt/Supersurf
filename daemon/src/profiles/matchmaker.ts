/**
 * Matchmaker — connection pool and profile-based routing.
 *
 * Manages a pool of extension WebSocket connections (with or without profile names)
 * and matches them to agent connect requests. Handles the "poaching" race condition
 * where unmanaged connects could steal managed spawns via pendingSpawns tracking.
 *
 * @module profiles/matchmaker
 */

import crypto from 'crypto';
import { WebSocket } from 'ws';
import type { FileLogger } from 'shared';
import type { PooledConnection, PendingMatch, VersionRejection } from './types';

const debugLog = (...args: unknown[]) => {
  const logger = (global as any).DAEMON_LOGGER as FileLogger | undefined;
  if (logger) logger.log('[Match]', ...args);
  else if ((global as any).DAEMON_DEBUG) console.error('[Match]', ...args);
};

const DEFAULT_TIMEOUT = 60000; // 60s total

/**
 * A connection is only matchable once its handshake has been checked.
 * 'pending' is excluded deliberately: the connection is pooled before its
 * handshake lands (extension-bridge.ts), so without this gate a mismatched
 * extension could win an immediate match before it is ever checked. The bridge
 * arms a bounded handshake deadline so nothing stays 'pending' forever.
 */
function isUsable(conn: PooledConnection): boolean {
  return conn.versionStatus === 'ok' || conn.versionStatus === 'warn';
}

export class Matchmaker {
  private pool: Map<WebSocket, PooledConnection> = new Map();
  private pendingMatches: PendingMatch[] = [];
  /** Profiles currently being spawned — blocks unmanaged matching to prevent poaching. */
  pendingSpawns: Set<string> = new Set();
  /** Serializes first-time profile spawns. */
  private bootstrapQueue: Promise<void> = Promise.resolve();
  /**
   * Version rejections keyed by profile ('' is the unmanaged slot). Retained
   * after the offending socket closes so a later requestMatch fails fast with a
   * named error instead of burning the full match window.
   */
  private versionRejections: Map<string, VersionRejection> = new Map();

  /** Get the number of connections in the pool. */
  get poolSize(): number {
    return this.pool.size;
  }

  /** Check if any connection exists in the pool. */
  get hasConnections(): boolean {
    return this.pool.size > 0;
  }

  /** Add a new extension connection to the pool. */
  addConnection(ws: WebSocket, conn: PooledConnection): void {
    this.pool.set(ws, conn);
    debugLog(`Connection added to pool (profile=${conn.profile || 'unmanaged'}, pool=${this.pool.size})`);
    this.tryResolvePendingMatches();
  }

  /** Remove a connection from the pool. Drains its inflight requests. */
  removeConnection(ws: WebSocket): void {
    const conn = this.pool.get(ws);
    if (!conn) return;

    // Drain inflight
    for (const [, pending] of conn.inflight) {
      pending.reject(new Error('Extension disconnected'));
    }
    conn.inflight.clear();

    // Clear ping interval
    if (conn.pingInterval) {
      clearInterval(conn.pingInterval);
      conn.pingInterval = null;
    }

    this.pool.delete(ws);
    debugLog(`Connection removed from pool (profile=${conn.profile || 'unmanaged'}, pool=${this.pool.size})`);
  }

  /** Update a connection's profile (e.g., after re-announcement). */
  updateProfile(ws: WebSocket, profile: string): void {
    const conn = this.pool.get(ws);
    if (!conn) return;
    const oldProfile = conn.profile;
    conn.profile = profile;
    debugLog(`Connection profile updated: ${oldProfile || 'unmanaged'} -> ${profile}`);
    this.tryResolvePendingMatches();
  }

  /**
   * Request a matching connection from the pool.
   *
   * @param profile - Profile name to match, or null for unmanaged
   * @param timeoutMs - Total timeout (default 60s)
   * @returns The matched PooledConnection
   */
  requestMatch(profile: string | null, timeoutMs: number = DEFAULT_TIMEOUT): Promise<PooledConnection> {
    // A version-rejected extension for this slot fails now, not in 45s.
    const rejection = this.getVersionRejection(profile);
    if (rejection) {
      debugLog(`Match refused for profile=${profile || 'unmanaged'} — version rejected`);
      return Promise.reject(new Error(rejection.message));
    }

    // Try immediate match
    const immediate = this.findMatch(profile);
    if (immediate) {
      debugLog(`Immediate match for profile=${profile || 'unmanaged'}`);
      return Promise.resolve(immediate);
    }

    // Queue as pending match
    return new Promise<PooledConnection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from pending
        this.pendingMatches = this.pendingMatches.filter(p => p.resolve !== resolve);
        reject(new Error(
          profile
            ? `No extension connection for profile '${profile}' after ${Math.round(timeoutMs / 1000)}s — Chromium may not have started, or its extension never announced.`
            : 'No unmanaged browser connection available.'
        ));
      }, timeoutMs);

      const pending: PendingMatch = { profile, resolve, reject, timeout, retries: 0 };
      this.pendingMatches.push(pending);
      debugLog(`Pending match queued for profile=${profile || 'unmanaged'} (pending=${this.pendingMatches.length})`);
    });
  }

  /** Find a matching connection in the pool. */
  private findMatch(profile: string | null): PooledConnection | null {
    if (profile === null) {
      // Unmanaged: block while profile spawns are pending
      if (this.pendingSpawns.size > 0) {
        debugLog('Unmanaged match blocked — pending spawns active');
        return null;
      }
      for (const conn of this.pool.values()) {
        if (conn.profile === null && conn.ws.readyState === WebSocket.OPEN && isUsable(conn)) {
          return conn;
        }
      }
      return null;
    }

    // Managed: find matching profile
    for (const conn of this.pool.values()) {
      if (conn.profile === profile && conn.ws.readyState === WebSocket.OPEN && isUsable(conn)) {
        return conn;
      }
    }
    return null;
  }

  /** Try to resolve pending matches against the current pool. */
  tryResolvePendingMatches(): void {
    const resolved: PendingMatch[] = [];

    for (const pending of this.pendingMatches) {
      const match = this.findMatch(pending.profile);
      if (match) {
        clearTimeout(pending.timeout);
        pending.resolve(match);
        resolved.push(pending);
        debugLog(`Pending match resolved for profile=${pending.profile || 'unmanaged'}`);
      }
    }

    if (resolved.length > 0) {
      this.pendingMatches = this.pendingMatches.filter(p => !resolved.includes(p));
    }
  }

  /**
   * Reject every pending match for a slot with a specific error.
   *
   * The reject path closes the offending socket, which removes it from the
   * pool — but a queued PendingMatch has no way to learn why its candidate
   * vanished and would otherwise sit until its own timeout. That timeout is
   * exactly the failure mode the version guard exists to replace.
   *
   * @returns How many pending matches were failed.
   */
  failPendingMatches(profile: string | null, error: Error): number {
    const doomed = this.pendingMatches.filter(p => p.profile === profile);
    if (doomed.length === 0) return 0;

    this.pendingMatches = this.pendingMatches.filter(p => p.profile !== profile);
    for (const pending of doomed) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    debugLog(`Failed ${doomed.length} pending match(es) for profile=${profile || 'unmanaged'}: ${error.message}`);
    return doomed.length;
  }

  /** Remember a version rejection so a later requestMatch fails fast. */
  recordVersionRejection(rejection: VersionRejection): void {
    this.versionRejections.set(rejection.profile ?? '', rejection);
    debugLog(`Version rejection recorded for profile=${rejection.profile || 'unmanaged'} (${rejection.version})`);
  }

  /** Forget a version rejection — a healthy extension took the slot. */
  clearVersionRejection(profile: string | null): void {
    if (this.versionRejections.delete(profile ?? '')) {
      debugLog(`Version rejection cleared for profile=${profile || 'unmanaged'}`);
    }
  }

  /** The recorded version rejection for a slot, if any. */
  getVersionRejection(profile: string | null): VersionRejection | null {
    return this.versionRejections.get(profile ?? '') ?? null;
  }

  /**
   * The recorded rejection for the UNMANAGED slot, or null. Backs the
   * `extensionVersionError` field on session_ack, which is emitted before any
   * profile binding exists — so the unmanaged slot is the only slot a
   * not-yet-bound session could use. Deliberately does NOT fall back to a
   * managed profile's rejection: that would surface profile A's broken
   * extension to a session that never touches profile A. Managed sessions
   * learn their own rejection, correctly scoped, through requestMatch.
   */
  get lastVersionRejection(): VersionRejection | null {
    return this.versionRejections.get('') ?? null;
  }

  /**
   * Send a JSON-RPC 2.0 request to a specific pooled connection.
   * Correlation and timeout are per-connection.
   */
  sendCmd(conn: PooledConnection, method: string, params: Record<string, unknown> = {}, timeout: number = 30000): Promise<any> {
    if (conn.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Extension not connected'));
    }

    const id = crypto.randomUUID().slice(0, 8);

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        conn.inflight.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      conn.inflight.set(id, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      const message = { jsonrpc: '2.0', id, method, params };
      conn.ws.send(JSON.stringify(message));
    });
  }

  /** Get the connection for a specific profile (or null for unmanaged). */
  getConnectionForProfile(profile: string | null): PooledConnection | null {
    return this.findMatch(profile);
  }

  /** Serialize a bootstrap operation through the queue. */
  enqueueBootstrap<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.bootstrapQueue = this.bootstrapQueue.then(
        () => fn().then(resolve, reject),
        () => fn().then(resolve, reject),
      );
    });
  }

  /** Shut down: clear all pending matches, close all connections. */
  shutdown(): void {
    for (const pending of this.pendingMatches) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Daemon shutting down'));
    }
    this.pendingMatches = [];

    for (const [ws, conn] of this.pool) {
      if (conn.pingInterval) {
        clearInterval(conn.pingInterval);
      }
      for (const [, inflight] of conn.inflight) {
        inflight.reject(new Error('Daemon shutting down'));
      }
      conn.inflight.clear();
      ws.close();
    }
    this.pool.clear();
    this.versionRejections.clear();
  }
}
