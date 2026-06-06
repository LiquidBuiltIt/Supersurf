/**
 * RequestScheduler — round-robin scheduler with tab ownership enforcement.
 *
 * Extracted from the multiplexer's leader-mode logic. Serializes all commands
 * to the extension through a single drain loop, ensuring fair round-robin
 * across sessions and automatic tab context-switching.
 *
 * @module scheduler
 */
import type { ExtensionBridge } from './extension-bridge';
import type { SessionRegistry } from './session';
/**
 * Round-robin request scheduler with tab ownership and auto context-switching.
 */
export declare class RequestScheduler {
    private bridge;
    private sessions;
    private requestQueue;
    private sessionOrder;
    private currentSessionIdx;
    private processingQueue;
    /** Current extension tab per profile (null key = unmanaged). */
    private currentExtensionTabIds;
    private sessionGroupIds;
    constructor(bridge: ExtensionBridge, sessions: SessionRegistry);
    /** Get the current extension tab ID for a given profile context. */
    private getCurrentTabId;
    /** Set the current extension tab ID for a given profile context. */
    private setCurrentTabId;
    /** Register a session in the scheduler. */
    addSession(sessionId: string): void;
    /** Remove a session from the scheduler. Rejects queued requests. */
    removeSession(sessionId: string): void;
    /** Enqueue a request and return a promise for the result. */
    enqueue(sessionId: string, method: string, params: Record<string, unknown>, timeout?: number): Promise<any>;
    /** Process queued requests in round-robin order. Serialized — one at a time. */
    private drainQueue;
    private hasQueuedRequests;
    /** Round-robin pick: advance through sessions, skip empty queues. */
    private pickNextRequest;
    /**
     * Execute a single queued request:
     * 1. Tab ownership check for tab-management methods
     * 2. Auto context-switch if this session's tab != current extension tab
     * 3. Inject _sessionId for extension-side group isolation
     * 4. Execute the actual command
     * 5. Track ownership changes
     */
    private executeRequest;
    /** Return total number of queued requests across all sessions. */
    getQueueDepth(): number;
    /** Drain and reject all queued requests. Called during shutdown. */
    drainAll(): void;
}
//# sourceMappingURL=scheduler.d.ts.map