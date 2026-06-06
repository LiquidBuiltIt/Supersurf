/**
 * Matchmaker — connection pool and profile-based routing.
 *
 * Manages a pool of extension WebSocket connections (with or without profile names)
 * and matches them to agent connect requests. Handles the "poaching" race condition
 * where unmanaged connects could steal managed spawns via pendingSpawns tracking.
 *
 * @module profiles/matchmaker
 */
import { WebSocket } from 'ws';
import type { PooledConnection } from './types';
export declare class Matchmaker {
    private pool;
    private pendingMatches;
    /** Profiles currently being spawned — blocks unmanaged matching to prevent poaching. */
    pendingSpawns: Set<string>;
    /** Serializes first-time profile spawns. */
    private bootstrapQueue;
    /** Get the number of connections in the pool. */
    get poolSize(): number;
    /** Check if any connection exists in the pool. */
    get hasConnections(): boolean;
    /** Add a new extension connection to the pool. */
    addConnection(ws: WebSocket, conn: PooledConnection): void;
    /** Remove a connection from the pool. Drains its inflight requests. */
    removeConnection(ws: WebSocket): void;
    /** Update a connection's profile (e.g., after re-announcement). */
    updateProfile(ws: WebSocket, profile: string): void;
    /**
     * Request a matching connection from the pool.
     *
     * @param profile - Profile name to match, or null for unmanaged
     * @param timeoutMs - Total timeout (default 60s)
     * @returns The matched PooledConnection
     */
    requestMatch(profile: string | null, timeoutMs?: number): Promise<PooledConnection>;
    /** Find a matching connection in the pool. */
    private findMatch;
    /** Try to resolve pending matches against the current pool. */
    private tryResolvePendingMatches;
    /**
     * Send a JSON-RPC 2.0 request to a specific pooled connection.
     * Correlation and timeout are per-connection.
     */
    sendCmd(conn: PooledConnection, method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
    /** Get the connection for a specific profile (or null for unmanaged). */
    getConnectionForProfile(profile: string | null): PooledConnection | null;
    /** Serialize a bootstrap operation through the queue. */
    enqueueBootstrap<T>(fn: () => Promise<T>): Promise<T>;
    /** Shut down: clear all pending matches, close all connections. */
    shutdown(): void;
}
//# sourceMappingURL=matchmaker.d.ts.map