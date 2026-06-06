"use strict";
/**
 * Matchmaker — connection pool and profile-based routing.
 *
 * Manages a pool of extension WebSocket connections (with or without profile names)
 * and matches them to agent connect requests. Handles the "poaching" race condition
 * where unmanaged connects could steal managed spawns via pendingSpawns tracking.
 *
 * @module profiles/matchmaker
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Matchmaker = void 0;
const crypto_1 = __importDefault(require("crypto"));
const ws_1 = require("ws");
const debugLog = (...args) => {
    const logger = global.DAEMON_LOGGER;
    if (logger)
        logger.log('[Match]', ...args);
    else if (global.DAEMON_DEBUG)
        console.error('[Match]', ...args);
};
const MATCH_RETRY_INTERVAL = 15000; // 15s between retries
const MAX_RETRIES = 4;
const DEFAULT_TIMEOUT = 60000; // 60s total
class Matchmaker {
    pool = new Map();
    pendingMatches = [];
    /** Profiles currently being spawned — blocks unmanaged matching to prevent poaching. */
    pendingSpawns = new Set();
    /** Serializes first-time profile spawns. */
    bootstrapQueue = Promise.resolve();
    /** Get the number of connections in the pool. */
    get poolSize() {
        return this.pool.size;
    }
    /** Check if any connection exists in the pool. */
    get hasConnections() {
        return this.pool.size > 0;
    }
    /** Add a new extension connection to the pool. */
    addConnection(ws, conn) {
        this.pool.set(ws, conn);
        debugLog(`Connection added to pool (profile=${conn.profile || 'unmanaged'}, pool=${this.pool.size})`);
        this.tryResolvePendingMatches();
    }
    /** Remove a connection from the pool. Drains its inflight requests. */
    removeConnection(ws) {
        const conn = this.pool.get(ws);
        if (!conn)
            return;
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
    updateProfile(ws, profile) {
        const conn = this.pool.get(ws);
        if (!conn)
            return;
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
    requestMatch(profile, timeoutMs = DEFAULT_TIMEOUT) {
        // Try immediate match
        const immediate = this.findMatch(profile);
        if (immediate) {
            debugLog(`Immediate match for profile=${profile || 'unmanaged'}`);
            return Promise.resolve(immediate);
        }
        // Queue as pending match
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                // Remove from pending
                this.pendingMatches = this.pendingMatches.filter(p => p.resolve !== resolve);
                reject(new Error(profile
                    ? `Connection timeout after ${MAX_RETRIES} retries — Chromium may not have started.`
                    : 'No unmanaged browser connection available.'));
            }, timeoutMs);
            const pending = { profile, resolve, reject, timeout, retries: 0 };
            this.pendingMatches.push(pending);
            debugLog(`Pending match queued for profile=${profile || 'unmanaged'} (pending=${this.pendingMatches.length})`);
        });
    }
    /** Find a matching connection in the pool. */
    findMatch(profile) {
        if (profile === null) {
            // Unmanaged: block while profile spawns are pending
            if (this.pendingSpawns.size > 0) {
                debugLog('Unmanaged match blocked — pending spawns active');
                return null;
            }
            for (const conn of this.pool.values()) {
                if (conn.profile === null && conn.ws.readyState === ws_1.WebSocket.OPEN) {
                    return conn;
                }
            }
            return null;
        }
        // Managed: find matching profile
        for (const conn of this.pool.values()) {
            if (conn.profile === profile && conn.ws.readyState === ws_1.WebSocket.OPEN) {
                return conn;
            }
        }
        return null;
    }
    /** Try to resolve pending matches against the current pool. */
    tryResolvePendingMatches() {
        const resolved = [];
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
     * Send a JSON-RPC 2.0 request to a specific pooled connection.
     * Correlation and timeout are per-connection.
     */
    sendCmd(conn, method, params = {}, timeout = 30000) {
        if (conn.ws.readyState !== ws_1.WebSocket.OPEN) {
            return Promise.reject(new Error('Extension not connected'));
        }
        const id = crypto_1.default.randomUUID().slice(0, 8);
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
    getConnectionForProfile(profile) {
        return this.findMatch(profile);
    }
    /** Serialize a bootstrap operation through the queue. */
    enqueueBootstrap(fn) {
        return new Promise((resolve, reject) => {
            this.bootstrapQueue = this.bootstrapQueue.then(() => fn().then(resolve, reject), () => fn().then(resolve, reject));
        });
    }
    /** Shut down: clear all pending matches, close all connections. */
    shutdown() {
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
    }
}
exports.Matchmaker = Matchmaker;
//# sourceMappingURL=matchmaker.js.map