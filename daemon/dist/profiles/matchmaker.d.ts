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
import type { PooledConnection, VersionRejection } from './types';
export declare class Matchmaker {
    private pool;
    private pendingMatches;
    /** Profiles currently being spawned — blocks unmanaged matching to prevent poaching. */
    pendingSpawns: Set<string>;
    /** Serializes first-time profile spawns. */
    private bootstrapQueue;
    /**
     * Version rejections keyed by profile ('' is the unmanaged slot). Retained
     * after the offending socket closes so a later requestMatch fails fast with a
     * named error instead of burning the full match window.
     */
    private versionRejections;
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
    tryResolvePendingMatches(): void;
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
    failPendingMatches(profile: string | null, error: Error): number;
    /** Remember a version rejection so a later requestMatch fails fast. */
    recordVersionRejection(rejection: VersionRejection): void;
    /** Forget a version rejection — a healthy extension took the slot. */
    clearVersionRejection(profile: string | null): void;
    /** The recorded version rejection for a slot, if any. */
    getVersionRejection(profile: string | null): VersionRejection | null;
    /**
     * The recorded rejection for the UNMANAGED slot, or null. Backs the
     * `extensionVersionError` field on session_ack, which is emitted before any
     * profile binding exists — so the unmanaged slot is the only slot a
     * not-yet-bound session could use. Deliberately does NOT fall back to a
     * managed profile's rejection: that would surface profile A's broken
     * extension to a session that never touches profile A. Managed sessions
     * learn their own rejection, correctly scoped, through requestMatch.
     */
    get lastVersionRejection(): VersionRejection | null;
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