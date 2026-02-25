/**
 * Multiplexer — session multiplexing for concurrent MCP clients.
 *
 * Implements IExtensionTransport. On start(), tries to bind the port (leader mode).
 * If port is taken, connects as a follower through the existing leader.
 * Followers transparently proxy commands through the leader to the extension.
 *
 * Leader responsibilities:
 *   - Accept extension connections (delegated to ExtensionServer)
 *   - Accept peer (follower) connections, proxy their requests to the extension
 *   - Track tab ownership per session (selectTab/createTab claim, closeTab releases)
 *   - Round-robin scheduler: one tool call per session turn, auto context-switch
 *   - Broadcast reconnect/tab-info events to relevant peers
 *   - Inject _sessionId into all commands for extension-side group isolation
 *
 * Follower responsibilities:
 *   - Connect to leader via WebSocket, send peer handshake
 *   - Forward sendCmd() calls through leader, manage own inflight map
 *   - On leader disconnect, attempt promotion (race with other followers)
 */
import { type IExtensionTransport } from '../bridge';
/**
 * Session multiplexer for concurrent MCP clients sharing one Chrome extension.
 *
 * Implements IExtensionTransport so it can be used as a drop-in replacement
 * for ExtensionServer. On start(), tries to bind the WebSocket port:
 * - Success: becomes the **leader** — accepts extension + peer connections,
 *   manages tab ownership, runs round-robin scheduler.
 * - EADDRINUSE: becomes a **follower** — proxies commands through the leader.
 *
 * If the leader goes down, followers race to promote (with random jitter to
 * avoid thundering herd).
 */
export declare class Multiplexer implements IExtensionTransport {
    private port;
    private host;
    private sessionId;
    private mode;
    private extensionServer;
    private peers;
    private leaderTabOwnership;
    private leaderAttachedTabId;
    private leaderGroupId;
    private requestQueue;
    private sessionOrder;
    private currentSessionIdx;
    private processingQueue;
    private currentExtensionTabId;
    private sessionGroupIds;
    private leaderSocket;
    private inflight;
    private _browser;
    private _buildTime;
    private _connected;
    private promotionInProgress;
    onReconnect: (() => void) | null;
    onTabInfoUpdate: ((tabInfo: any) => void) | null;
    constructor(port: number | undefined, host: string | undefined, sessionId: string);
    /** Expose multiplexer status for the status tool. */
    getStatus(): {
        role: string | null;
        session: string;
        peers: number;
        sessions: string[];
    };
    get connected(): boolean;
    get browser(): string;
    get buildTime(): string | null;
    /**
     * Attempt to start as leader; fall back to follower if port is taken.
     * This is the only public entry point for initialization.
     */
    start(): Promise<void>;
    /** Bind the port, start WebSocket server, and initialize leader state (queues, tab ownership). */
    private startAsLeader;
    /** Register a new follower connection. Sets up message routing, ownership tracking, and cleanup on close. */
    private acceptPeer;
    /** Parse incoming JSON-RPC from a peer and enqueue it in the round-robin scheduler. */
    private handlePeerMessage;
    /** Add a request to the session's queue and trigger the drain loop. */
    private enqueueRequest;
    /** Process queued requests in round-robin order until all queues are empty. Serialized — only one drain loop runs at a time. */
    private drainQueue;
    private hasQueuedRequests;
    /**
     * Round-robin pick: advance through sessions, skip empty queues.
     */
    private pickNextRequest;
    /**
     * Execute a single queued request:
     * 1. Tab ownership check for tab-management methods
     * 2. Auto context-switch (selectTab by ID) if this session's tab != current extension tab
     * 3. Inject _sessionId for extension-side group isolation
     * 4. Execute the actual command
     * 5. Track ownership changes
     */
    private executeRequest;
    private getSessionAttachedTabId;
    private setSessionAttachedTabId;
    private setSessionGroupId;
    /**
     * Find which session owns a tab by its ID.
     */
    private findTabOwnerByTabId;
    /**
     * Filter tab list — show tabs owned by this session + unowned tabs.
     * Defense-in-depth: extension already filters by group via _sessionId.
     */
    private filterTabsForSession;
    /** Connect to an existing leader via WebSocket /peer endpoint. Resolves on peer_ack, rejects on timeout or rejection. */
    private startAsFollower;
    /**
     * Race to become leader after the current leader disconnects.
     * Uses random jitter (50-200ms) to reduce collision likelihood.
     * If another follower wins, backs off and reconnects as follower.
     */
    private attemptPromotion;
    /**
     * Send a command to the extension. Leader enqueues through the scheduler for
     * fair round-robin; follower proxies through the leader via JSON-RPC.
     */
    sendCmd(method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
    /** Forward a command to the leader as a JSON-RPC request. Manages timeout and inflight tracking. */
    private sendCmdAsFollower;
    notifyClientId(clientId: string): void;
    /** Tear down all state: drain queues, close peers, stop extension server, reject inflight requests. */
    stop(): Promise<void>;
}
//# sourceMappingURL=multiplexer.d.ts.map