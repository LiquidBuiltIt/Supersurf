/**
 * WebSocket bridge to the Chrome extension.
 *
 * Runs an HTTP + WebSocket server on localhost (default port 5555).
 * Communication uses JSON-RPC 2.0 with correlation IDs for request/response matching.
 *
 * Key behaviors:
 *   - Single-connection model: rejects additional browsers while one is connected
 *   - 10s keep-alive pings to detect stale connections
 *   - 30s default timeout on `sendCmd` requests
 *   - Handles three message types: responses (correlated by id), handshakes (browser info),
 *     and notifications (tab info updates)
 *   - `onRawConnection` hook for multiplexer to intercept connections before default handling
 *
 * @module bridge
 * @exports IExtensionTransport - Interface for the transport layer
 * @exports ExtensionServer - Concrete WebSocket implementation
 */
import http from 'http';
import { WebSocket } from 'ws';
/** Transport interface abstracting the WebSocket connection to the Chrome extension. */
export interface IExtensionTransport {
    sendCmd(method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
    readonly connected: boolean;
    readonly browser: string;
    readonly buildTime: string | null;
    onReconnect: (() => void) | null;
    onTabInfoUpdate: ((tabInfo: any) => void) | null;
    notifyClientId(clientId: string): void;
    start(): Promise<void>;
    stop(): Promise<void>;
}
/**
 * WebSocket server that bridges the MCP server to the Chrome extension.
 * Manages a single active connection, with reconnection support.
 */
export declare class ExtensionServer implements IExtensionTransport {
    private port;
    private host;
    private httpServer;
    private wss;
    private socket;
    private inflight;
    private browserType;
    private buildTimestamp;
    private pingInterval;
    onReconnect: (() => void) | null;
    onTabInfoUpdate: ((tabInfo: any) => void) | null;
    onRawConnection: ((ws: WebSocket, request: http.IncomingMessage) => boolean) | null;
    constructor(port?: number, host?: string);
    get browser(): string;
    get buildTime(): string | null;
    get connected(): boolean;
    /** Spin up the HTTP + WebSocket server and begin accepting connections. */
    start(): Promise<void>;
    /** Route incoming WebSocket messages: responses, handshakes, or notifications. */
    private handleMessage;
    /**
     * Send a JSON-RPC 2.0 request to the extension and await the response.
     * @param method - Command name (e.g., 'evaluateScript', 'forwardCDPCommand')
     * @param params - Command parameters
     * @param timeout - Max wait time in ms (default 30s)
     * @throws If extension is disconnected or request times out
     */
    sendCmd(method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
    /** Send an `authenticated` notification to the extension with the session's client ID. */
    notifyClientId(clientId: string): void;
    /** Reject all pending requests with a disconnect error and clear the inflight map. */
    private drainInflight;
    /** Gracefully shut down: clear ping interval, close socket, close servers. */
    stop(): Promise<void>;
}
//# sourceMappingURL=bridge.d.ts.map