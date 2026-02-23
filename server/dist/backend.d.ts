/**
 * ConnectionManager — central state machine for the server's connection lifecycle.
 *
 * States:
 *   - **passive** — server is idle, only connection tools (enable/disable/status) are available
 *   - **active** — WebSocket server is listening, waiting for extension to connect
 *   - **connected** — extension linked, all browser tools available
 *
 * This module owns state transitions and tool dispatch. It delegates:
 *   - Tool schemas to `backend/schemas.ts`
 *   - Status header formatting to `backend/status.ts`
 *   - Handler implementations to `backend/handlers.ts`
 *
 * BrowserBridge is lazy-imported to break a circular dependency (tools.ts imports backend types).
 *
 * @module backend
 * @exports ConnectionManager
 * @exports BackendConfig, TabInfo, BackendState, ToolSchema (re-exported from backend/types)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { IExtensionTransport } from './bridge';
export type { BackendConfig, TabInfo, BackendState, ToolSchema } from './backend/types';
import type { BackendConfig, TabInfo, BackendState, ToolSchema, ConnectionManagerAPI } from './backend/types';
/**
 * Core state machine for managing the extension connection lifecycle.
 * Implements ConnectionManagerAPI so handler functions can read/write state.
 */
export declare class ConnectionManager implements ConnectionManagerAPI {
    config: BackendConfig;
    state: BackendState;
    bridge: any;
    extensionServer: IExtensionTransport | null;
    debugMode: boolean;
    clientId: string | null;
    connectedBrowserName: string | null;
    attachedTab: TabInfo | null;
    stealthMode: boolean;
    server: Server | null;
    clientInfo: Record<string, unknown>;
    constructor(config: BackendConfig);
    /** Store server reference and client metadata. Does not start the WebSocket — that happens in `enable`. */
    initialize(server: Server | null, clientInfo: Record<string, unknown>): Promise<void>;
    /** Build a one-line status string prepended to every tool response. */
    statusHeader(): string;
    /** Return all available tool schemas: connection tools + browser tools + debug tools (if enabled). */
    listTools(): Promise<ToolSchema[]>;
    /**
     * Dispatch a tool call. Connection tools are handled locally; browser tools
     * forward to BrowserBridge. Returns MCP content response or raw JSON (script mode).
     * @param rawResult - When true, return plain objects instead of MCP content wrappers
     */
    callTool(name: string, rawArguments?: Record<string, unknown>, options?: {
        rawResult?: boolean;
    }): Promise<any>;
    /** Signal MCP client that the available tool list has changed (e.g., after enable/disable). */
    notifyToolsListChanged(): Promise<void>;
    /** Send an MCP logging notification to the client (info, warn, error). Silently no-ops if unsupported. */
    sendLogNotification(level: string, message: string, logger?: string): Promise<void>;
    setAttachedTab(tab: TabInfo | null): void;
    getAttachedTab(): TabInfo | null;
    clearAttachedTab(): void;
    setConnectedBrowserName(name: string): void;
    setStealthMode(enabled: boolean): void;
    /** Tear down bridge, stop WebSocket server, reset to passive. Called on SIGINT or explicit shutdown. */
    serverClosed(): Promise<void>;
}
//# sourceMappingURL=backend.d.ts.map