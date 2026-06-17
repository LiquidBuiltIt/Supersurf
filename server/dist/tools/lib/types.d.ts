/**
 * Shared types for modular tool handlers.
 *
 * Defines {@link ToolSchema} (tool registration metadata) and
 * {@link ToolContext} (the runtime context every handler receives).
 *
 * @module tools/types
 */
import type { IExtensionTransport } from '../../bridge';
import type { ConfigService } from 'shared';
/**
 * MCP tool registration metadata.
 * Each schema is exposed to the AI agent as an available tool.
 */
export interface ToolSchema {
    /** Unique tool name, typically snake_case (e.g. `browser_tabs`). */
    name: string;
    /** Human-readable description shown to the agent. */
    description: string;
    /** JSON Schema describing the tool's expected input parameters. */
    inputSchema: Record<string, unknown>;
    /** Optional MCP annotations (readOnlyHint, destructiveHint, etc.). */
    annotations?: Record<string, unknown>;
}
/**
 * Context object passed to every tool handler.
 * Exposes the subset of BrowserBridge internals that handlers need.
 */
export interface ToolContext {
    /** Transport for sending commands to the Chrome extension. */
    ext: IExtensionTransport;
    /** Tracks connection state, attached tab, stealth mode, etc. */
    connectionManager: any;
    /** Resolved ConfigService (CLI + env + file + defaults). Optional for legacy callers. */
    config?: ConfigService;
    /** Usage-metrics logger, when enabled. Used by the action recorder. */
    metricsLogger?: import('../../usage-metrics-logger').UsageMetricsLogger | null;
    /**
     * Explicit target tab id for this call (from the tool's `tabId` arg), or
     * undefined to use the session's attached tab. Baked into `cdp`/`eval`/
     * `getElementCenter`; direct `sendCmd` handlers forward it in their payload.
     * Concurrency isolation for parallel callers sharing one session.
     */
    tabId?: number;
    /** Send a Chrome DevTools Protocol command through the extension. */
    cdp(method: string, params?: any): Promise<any>;
    /** Evaluate a JS expression in the page context (via CDP Runtime.evaluate). */
    eval(expression: string, awaitPromise?: boolean): Promise<any>;
    /** Async sleep utility. */
    sleep(ms: number): Promise<void>;
    /** Resolve a CSS selector to its element's viewport center coordinates. Throws with "Did you mean?" hints on failure. */
    getElementCenter(selector: string): Promise<{
        x: number;
        y: number;
    }>;
    /**
     * Fingerprint an element that was resolved inside a child frame (iframe), bound to that
     * frame's execution context. The top-frame capture path (`getElementCenter` →
     * `resolveWithHealing`) can't see iframe elements, so the frame-walk fallback fires this.
     * Fire-and-forget; gated by the fingerprinting experiment. Optional — wired by BrowserBridge.
     */
    captureFingerprintInContext?(contextId: number, selector: string): void;
    /**
     * Heal a selector miss inside a child frame (iframe) by scoring a stored fingerprint
     * against that frame's DOM, bound to the frame's execution context. Returns the
     * gate-passing hit's **iframe-local** center + score (the caller translates to top-frame
     * coords), or null when no record exists / the gate fails. Gated by the fingerprinting
     * experiment. Optional — wired by BrowserBridge.
     */
    healFingerprintInContext?(contextId: number, selector: string): Promise<{
        cx: number;
        cy: number;
        score: number;
    } | null>;
    /** Convert a selector string (including `:has-text()`) to a JS querySelector expression. */
    getSelectorExpression(selector: string): string;
    /** Search the page for elements matching partial text when a selector fails. */
    findAlternativeSelectors(selector: string): Promise<any[]>;
    /** Wrap a handler result into MCP content blocks with status header. */
    formatResult(name: string, result: any, options: {
        rawResult?: boolean;
    }): any;
    /** Return a formatted error (MCP error block or raw `{ success: false }`). */
    error(message: string, options: {
        rawResult?: boolean;
    }): any;
}
//# sourceMappingURL=types.d.ts.map