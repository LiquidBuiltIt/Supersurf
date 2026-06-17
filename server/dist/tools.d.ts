/**
 * BrowserBridge — orchestrator for browser tool dispatch.
 *
 * Thin lifecycle wrapper. Builds a ToolContext from the transport,
 * connection manager, and helper modules, then delegates dispatch to
 * `tools/dispatcher.ts`. The CDP/eval primitives, element resolver, and
 * result formatter live in sibling modules.
 *
 * @module tools
 */
import type { IExtensionTransport } from './bridge';
import type { ToolSchema } from './tools/lib/types';
import { UsageMetricsLogger } from './usage-metrics-logger';
/**
 * Lifecycle wrapper for browser tool execution. Created by
 * `backend/handlers.ts:onConnect` after the daemon transport is up;
 * `initialize()` wires in the MCP server, client metadata, connection
 * manager, and (optional) usage-metrics logger.
 */
export declare class BrowserBridge {
    private config;
    private ext;
    private server;
    private clientInfo;
    private connectionManager;
    private metricsLogger;
    constructor(config: any, ext: IExtensionTransport | null);
    initialize(server: any, clientInfo: any, connectionManager?: any, metricsLogger?: UsageMetricsLogger | null): Promise<void>;
    serverClosed(): void;
    /** Return all registered tool schemas (core + experimental). */
    listTools(): Promise<ToolSchema[]>;
    /**
     * Build the ToolContext that handlers receive.
     *
     * `tabId` (from the caller's `tabId` arg) is baked into `cdp`/`eval`/
     * `getElementCenter` so the entire selector/eval/CDP surface targets one
     * tab — concurrency isolation for parallel callers sharing a session.
     */
    private buildContext;
    /**
     * Dispatch a named tool call. Short-circuits with a help-text error
     * when the extension transport is missing, otherwise forwards to
     * `dispatchTool`.
     */
    callTool(name: string, args?: Record<string, unknown>, options?: {
        rawResult?: boolean;
    }): Promise<any>;
}
//# sourceMappingURL=tools.d.ts.map