/**
 * IPC Server — Unix socket server for MCP session connections.
 *
 * Accepts connections from MCP servers over a Unix domain socket.
 * Protocol:
 *   1. MCP server sends: { type: "session_register", sessionId: "..." }\n
 *   2. Daemon responds: { type: "session_ack", browser: "...", buildTimestamp: "...",
 *                          extensionVersionError: string | null }\n
 *      or { type: "session_reject", reason: "..." }\n
 *      `extensionVersionError` is null whenever no extension has been rejected for a
 *      version mismatch, which is the normal case. It is only a string while the
 *      unmanaged slot is holding a rejection.
 *   3. Post-handshake: NDJSON (newline-delimited JSON-RPC 2.0) for tool calls
 *
 * @module ipc
 */
import type { ExtensionBridge } from './extension-bridge';
import type { SessionRegistry } from './session';
import type { RequestScheduler } from './scheduler';
import type { DaemonExperimentRegistry } from './experiments/index';
import type { ProfileRegistry } from './profiles/registry';
/** Callback invoked when the number of sessions changes (for idle timeout management). */
export type SessionCountCallback = (count: number) => void;
/** Metadata passed from main to IPCServer for status queries. */
export interface IPCServerMeta {
    port: number;
    version: string;
    startupOpts?: {
        disableGpu?: boolean;
        chromePath?: string | null;
    };
    /**
     * Why the startup extension pull failed, or null/undefined if it succeeded.
     * Carried so spawnProfile can fail with a cause instead of launching a
     * Chromium that will never connect.
     */
    extensionPullError?: string | null;
}
/**
 * Unix domain socket server for MCP session connections.
 * Handles session handshake, NDJSON message routing, and cleanup.
 */
export declare class IPCServer {
    private server;
    private socketPath;
    private bridge;
    private sessions;
    private scheduler;
    private experiments;
    private profileRegistry;
    private onSessionCountChange;
    private startedAt;
    private meta;
    private configDrift;
    constructor(socketPath: string, bridge: ExtensionBridge, sessions: SessionRegistry, scheduler: RequestScheduler, experiments: DaemonExperimentRegistry, profileRegistry: ProfileRegistry, meta?: IPCServerMeta);
    /** Set a callback for session count changes (used by idle timeout). */
    setSessionCountCallback(cb: SessionCountCallback): void;
    /** Mark that the on-disk config has changed since daemon startup. */
    setConfigDrift(drifted: boolean): void;
    /** Start listening on the Unix socket. */
    start(): Promise<void>;
    /** Handle a new connection from an MCP server. */
    private handleConnection;
    /** Route a JSON-RPC 2.0 request — experiment methods are handled directly, everything else goes to the scheduler. */
    private handleRequest;
    /** Handle an experiment IPC request directly (no scheduler round-trip). */
    private handleExperimentRequest;
    /** Handle a profile IPC request directly (no scheduler round-trip). */
    private handleProfileRequest;
    /**
     * Race the matchmaker wait against a liveness watch on the just-spawned
     * Chromium. Only watches when this request performed the spawn — a
     * user-launched browser is not registry-tracked, so watchPid=false skips
     * the watch entirely. The registry self-heals (spawnProfile's exit handler
     * clears the PID), so isRunning() flipping false means the process died.
     * Accepted scope gap: the watch only arms for Chromium this request spawned
     * (watchPid/didSpawn) — an already-running profile that dies mid-match
     * falls back to the full 45s timeout by design.
     */
    private awaitMatchWithDeathWatch;
    /**
     * Spawn Chromium for a profile through the bootstrap queue.
     * owner='daemon': killed when the last session for the profile disconnects.
     * owner='user': survives sessions, daemon shutdown, and the orphan sweep.
     */
    private spawnProfile;
    /** Build a status response from live daemon state. */
    private buildStatusResponse;
    /** Write an NDJSON line to a socket. Injects `config_drift` into session_ack
     *  and JSON-RPC response envelopes when the config file has changed since
     *  daemon startup. */
    private sendLine;
    /** Gracefully shut down the IPC server. */
    stop(): Promise<void>;
}
//# sourceMappingURL=ipc.d.ts.map