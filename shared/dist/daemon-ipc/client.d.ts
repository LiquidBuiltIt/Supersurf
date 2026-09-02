/**
 * DaemonClient — IExtensionTransport implementation over Unix domain socket.
 *
 * Connects to the daemon's IPC server, performs session handshake, and
 * routes JSON-RPC 2.0 tool calls through the daemon to the extension.
 *
 * @module daemon-client
 * @exports DaemonClient
 */
import type { IExtensionTransport, DialogEvent } from './types';
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
    private _configDrift;
    private _version;
    private _extensionConnected;
    private dialogEventBuffer;
    onReconnect: (() => void) | null;
    onTabInfoUpdate: ((tabInfo: any) => void) | null;
    constructor(sockPath: string, sessionId: string);
    get connected(): boolean;
    get browser(): string;
    get buildTime(): string | null;
    /** The daemon's reported package version, or null for a pre-v3 daemon. */
    get version(): string | null;
    /** Unmanaged-slot extension presence reported by the daemon on session_ack.
     *  False for pre-upgrade daemons that omit the field. */
    get extensionConnected(): boolean;
    /** True when the daemon has detected a config file change since its startup. */
    isConfigDrifted(): boolean;
    /** Drain and return buffered native-dialog events captured from prior responses. */
    consumeDialogEvents(): DialogEvent[];
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
//# sourceMappingURL=client.d.ts.map