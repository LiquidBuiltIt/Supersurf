/**
 * BrowserBridge — orchestrator for browser tool dispatch.
 *
 * Central class that AI agents interact with through the MCP protocol.
 * Owns CDP/eval helpers, element resolution utilities, and a switch-based
 * dispatcher that routes tool calls to modular handlers in `tools/`.
 *
 * Every tool handler receives a {@link ToolContext} built by this class,
 * which exposes a controlled subset of bridge internals (CDP, eval, sleep, etc.).
 *
 * @module tools
 */
import type { IExtensionTransport } from './bridge';
import type { ToolSchema } from './tools/types';
/**
 * Orchestrates all browser tool execution.
 *
 * Lifecycle: construct with config + transport, then call {@link initialize}
 * once the MCP server is ready. After that, {@link callTool} dispatches
 * named tool calls to the appropriate handler module.
 */
export declare class BrowserBridge {
    private config;
    private ext;
    private server;
    private clientInfo;
    private connectionManager;
    constructor(config: any, ext: IExtensionTransport | null);
    /**
     * Bind the MCP server, client metadata, and connection manager.
     * Must be called before any tool dispatch.
     */
    initialize(server: any, clientInfo: any, connectionManager?: any): Promise<void>;
    /** Cleanup hook called when the MCP server shuts down. */
    serverClosed(): void;
    /** Build the context object that tool handlers receive */
    private get ctx();
    /** Send a CDP command through the extension's forwardCDPCommand handler */
    private cdp;
    /** Evaluate JS expression in page context, return by value */
    private evalExpr;
    /** Sleep for specified ms */
    private sleep;
    /** Get center coordinates of an element by selector, with "Did you mean?" hints on failure */
    private getElementCenter;
    /** Search for alternative elements when a selector fails */
    private findAlternativeSelectors;
    /** Convert selector string to JS querySelector expression, handling :has-text() */
    private getSelectorExpression;
    /** Return all registered tool schemas (core + experimental). */
    listTools(): Promise<ToolSchema[]>;
    /** Tools that support the `screenshot` param for inline post-action capture. */
    private static SCREENSHOT_ELIGIBLE;
    /**
     * If `args.screenshot` is true and the tool is eligible, append a screenshot
     * image block to the result. Skips for rawResult mode and error results.
     */
    private maybeAppendScreenshot;
    /**
     * Dispatch a named tool call to the appropriate handler.
     *
     * @param name - MCP tool name (e.g. `browser_tabs`, `browser_interact`)
     * @param args - Tool arguments from the agent
     * @param options - If `rawResult` is true, return raw data instead of MCP content blocks
     * @returns MCP-formatted result with content blocks, or raw data
     */
    callTool(name: string, args?: Record<string, unknown>, options?: {
        rawResult?: boolean;
    }): Promise<any>;
    /**
     * Wrap a handler result into MCP content blocks, prepending the status header.
     * In rawResult mode, passes through unchanged. Also syncs tab/browser metadata
     * with the connection manager when present in the result.
     */
    private formatResult;
    /** Format an error as an MCP error block, or as `{ success: false }` in rawResult mode. */
    private error;
}
//# sourceMappingURL=tools.d.ts.map