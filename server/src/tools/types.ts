/**
 * Shared types for modular tool handlers.
 *
 * Defines {@link ToolSchema} (tool registration metadata) and
 * {@link ToolContext} (the runtime context every handler receives).
 *
 * @module tools/types
 */

import type { IExtensionTransport } from '../bridge';

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

  /** Send a Chrome DevTools Protocol command through the extension. */
  cdp(method: string, params?: any): Promise<any>;
  /** Evaluate a JS expression in the page context (via CDP Runtime.evaluate). */
  eval(expression: string, awaitPromise?: boolean): Promise<any>;
  /** Async sleep utility. */
  sleep(ms: number): Promise<void>;
  /** Resolve a CSS selector to its element's viewport center coordinates. Throws with "Did you mean?" hints on failure. */
  getElementCenter(selector: string): Promise<{ x: number; y: number }>;
  /** Convert a selector string (including `:has-text()`) to a JS querySelector expression. */
  getSelectorExpression(selector: string): string;
  /** Search the page for elements matching partial text when a selector fails. */
  findAlternativeSelectors(selector: string): Promise<any[]>;
  /** Wrap a handler result into MCP content blocks with status header. */
  formatResult(name: string, result: any, options: { rawResult?: boolean }): any;
  /** Return a formatted error (MCP error block or raw `{ success: false }`). */
  error(message: string, options: { rawResult?: boolean }): any;
}
