/**
 * WebSocket bridge to Chrome extension(s).
 *
 * Runs an HTTP + WebSocket server on localhost (default port 5555).
 * Communication uses JSON-RPC 2.0 with correlation IDs for request/response matching.
 *
 * When profiles are enabled, supports multiple concurrent extension connections via
 * the Matchmaker connection pool. When profiles are disabled, operates in single-
 * connection mode (rejects additional connections, same as v1).
 *
 * @module extension-bridge
 */
import { Matchmaker } from './profiles/matchmaker';
/**
 * WebSocket server that bridges the daemon to Chrome extension(s).
 * Supports both single-connection (v1) and pooled connection (profiles) modes.
 */
export declare class ExtensionBridge {
    private port;
    private host;
    private httpServer;
    private wss;
    private profilesEnabled;
    /** Connection pool and profile-based routing. */
    matchmaker: Matchmaker;
    onReconnect: (() => void) | null;
    onTabInfoUpdate: ((tabInfo: any) => void) | null;
    constructor(port?: number, host?: string, profilesEnabled?: boolean);
    /** Browser name from the first available connection (backwards compat). */
    get browser(): string;
    /** Build timestamp from the first available connection (backwards compat). */
    get buildTime(): string | null;
    /** True if at least one extension is connected. */
    get connected(): boolean;
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