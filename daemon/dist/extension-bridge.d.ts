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
import { Matchmaker } from './profiles/matchmaker';
/**
 * WebSocket server that bridges the daemon to Chrome extension(s).
 * Routes connections via the Matchmaker pool; unmanaged connections (no profile) are supported.
 */
export declare class ExtensionBridge {
    private port;
    private host;
    private httpServer;
    private wss;
    /** Connection pool and profile-based routing. */
    matchmaker: Matchmaker;
    onTabInfoUpdate: ((tabInfo: any) => void) | null;
    private daemonVersion;
    constructor(port?: number, host?: string, daemonVersion?: string);
    /** Browser name from the first available connection (backwards compat). */
    get browser(): string;
    /** Build timestamp from the first available connection (backwards compat). */
    get buildTime(): string | null;
    /** True if at least one extension is connected. */
    get connected(): boolean;
    /**
     * The most recent extension version rejection, or null. Rides session_ack so
     * an agent calling `connect` without a profile learns immediately, rather
     * than discovering it as a silent absence of browser tools.
     */
    get extensionVersionError(): string | null;
    /** Spin up the HTTP + WebSocket server and begin accepting connections. */
    start(): Promise<void>;
    /** Route incoming WebSocket messages for a specific connection. */
    private handleMessage;
    /**
     * Send a JSON-RPC 2.0 request to the unmanaged extension connection.
     * Backwards-compatible with v1 — delegates to matchmaker for the unmanaged connection.
     */
    sendCmd(method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
    /**
     * Send a JSON-RPC 2.0 request to a specific profile's extension connection.
     */
    sendCmdToProfile(profile: string, method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
    /** Send an `authenticated` notification to the extension with a session's client ID. */
    notifyClientId(clientId: string): void;
    /** Gracefully shut down: close all connections, close servers. */
    stop(): Promise<void>;
}
//# sourceMappingURL=extension-bridge.d.ts.map