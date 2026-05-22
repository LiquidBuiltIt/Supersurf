/**
 * DaemonClient — IExtensionTransport implementation over Unix domain socket.
 *
 * Connects to the daemon's IPC server, performs session handshake, and
 * routes JSON-RPC 2.0 tool calls through the daemon to the extension.
 *
 * @module daemon-client
 * @exports DaemonClient
 */
import type { IExtensionTransport } from './bridge';
/**
 * Transport that connects to the SuperSurf daemon over a Unix domain socket.
 * Implements IExtensionTransport for drop-in replacement of ExtensionServer.
 */
export declare class DaemonClient implements IExtensionTransport {
    private sockPath;
    private sessionId;
    private socket;
    private inflight;
    private buffer;
    private _connected;
    private _browser;
    private _buildTime;
    onReconnect: (() => void) | null;
    onTabInfoUpdate: ((tabInfo: any) => void) | null;
    constructor(sockPath: string, sessionId: string);
    get connected(): boolean;
    get browser(): string;
    get buildTime(): string | null;
    /**
     * Connect to the daemon, send session_register handshake, await session_ack.
     * Resolves when the session is established and browser info is available.
     */
    start(): Promise<void>;
    /**
     * Send a JSON-RPC 2.0 request to the daemon and await the response.
     */
    sendCmd(method: string, params?: Record<string, unknown>, timeout?: number): Promise<any>;
    /** No-op — daemon handles extension auth. */
    notifyClientId(_clientId: string): void;
    /** Close the Unix socket connection. Daemon stays alive for other sessions. */
    stop(): Promise<void>;
    /** Write an NDJSON line to the daemon socket. */
    private sendLine;
    /** Reject all pending requests. */
    private drainInflight;
    /** Clean up socket resources. */
    private cleanup;
}
//# sourceMappingURL=daemon-client.d.ts.map