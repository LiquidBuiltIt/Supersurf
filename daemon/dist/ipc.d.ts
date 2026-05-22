/**
 * IPC Server — Unix socket server for MCP session connections.
 *
 * Accepts connections from MCP servers over a Unix domain socket.
 * Protocol:
 *   1. MCP server sends: { type: "session_register", sessionId: "..." }\n
 *   2. Daemon responds: { type: "session_ack", browser: "...", buildTimestamp: "..." }\n
 *      or { type: "session_reject", reason: "..." }\n
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
    constructor(socketPath: string, bridge: ExtensionBridge, sessions: SessionRegistry, scheduler: RequestScheduler, experiments: DaemonExperimentRegistry, profileRegistry: ProfileRegistry, meta?: IPCServerMeta);
    /** Set a callback for session count changes (used by idle timeout). */
    setSessionCountCallback(cb: SessionCountCallback): void;
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
    /** Build a status response from live daemon state. */
    private buildStatusResponse;
    /** Write an NDJSON line to a socket. */
    private sendLine;
    /** Gracefully shut down the IPC server. */
    stop(): Promise<void>;
}
//# sourceMappingURL=ipc.d.ts.map