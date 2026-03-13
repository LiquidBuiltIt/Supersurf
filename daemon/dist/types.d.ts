/**
 * Shared types for the daemon package.
 *
 * @module types
 */
import type net from 'net';
/** State tracked per connected MCP session. */
export interface DaemonSession {
    sessionId: string;
    socket: net.Socket;
    ownedTabs: Set<number>;
    attachedTabId: number | null;
    groupId: number | null;
    profileId: string | null;
}
/** A request waiting in the round-robin scheduler queue. */
export interface QueuedRequest {
    sessionId: string;
    method: string;
    params: Record<string, unknown>;
    timeout: number;
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
}
/** Pending promise callbacks for an in-flight request to the extension. */
export interface InflightRequest {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
}
//# sourceMappingURL=types.d.ts.map