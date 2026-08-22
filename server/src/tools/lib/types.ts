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
import type { HandleMeta } from '../../experimental/fingerprinting/handle-meta';

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
  getElementCenter(selector: string, meta?: HandleMeta): Promise<{ x: number; y: number }>;
  /**
   * Fingerprint an element that was resolved inside a child frame (iframe), bound to that
   * frame's execution context. The top-frame capture path (`getElementCenter` →
   * `resolveWithHealing`) can't see iframe elements, so the frame-walk fallback fires this.
   * Fire-and-forget; gated by the fingerprinting experiment. Optional — wired by BrowserBridge.
   */
  captureFingerprintInContext?(contextId: number | null, selector: string, meta?: HandleMeta): void;
  /**
   * Heal a selector miss inside a given frame's execution context — or the top
   * frame's default context when `contextId` is null — by scoring a stored
   * fingerprint against that frame's DOM. Returns the gate-passing hit's
   * **frame-local** center + score (the caller translates to top-frame coords),
   * or null when no record exists / the gate fails. `objectId`/`resolvedExpr`
   * are set together, best-effort, when a live element could be re-resolved for
   * the hit (synthesized selector, falling back to `elementFromPoint`) — callers
   * that only need coordinates (click/hover) can ignore them; callers that need
   * to re-query the element by JS (type, select_option, fill_form, …) use
   * `resolvedExpr`; callers that need a raw CDP node (file_upload) use `objectId`.
   * Gated by the fingerprinting experiment. Optional — wired by BrowserBridge.
   */
  healFingerprintInContext?(contextId: number | null, selector: string): Promise<{ cx: number; cy: number; score: number; objectId?: string; resolvedExpr?: string } | null>;
  /**
   * Translate a playbook handle name (bare snake_case, e.g. `tweet_button`) into the
   * selector it was fingerprinted against. Synchronous, idempotent, and gated by the
   * `fingerprinting` experiment — a real CSS selector, or an unknown handle, comes back
   * unchanged. `getSelectorExpression` already applies this; call it directly only at
   * raw-CDP sites that bypass the expression builder. Optional — wired by BrowserBridge.
   */
  resolveSelector?(selector: string): string;
  /**
   * Build the reader-side handle index for the currently attached tab's URL, so
   * `browser_snapshot` / `browser_lookup` can show a recorded handle in place of a
   * raw selector. Call ONCE per tool call and probe the returned Map — never call it
   * per node. Gated by the `fingerprinting` experiment; returns an empty index when
   * off. Optional — wired by BrowserBridge.
   */
  getHandleIndex?(): import('../../experimental/fingerprinting/handle-annotate').HandleIndex;
  /** Convert a selector string (including `:has-text()`) to a JS querySelector expression. */
  getSelectorExpression(selector: string): string;
  /** Search the page for elements matching partial text when a selector fails. */
  findAlternativeSelectors(selector: string): Promise<any[]>;
  /** Wrap a handler result into MCP content blocks with status header. */
  formatResult(name: string, result: any, options: { rawResult?: boolean }): any;
  /** Return a formatted error (MCP error block or raw `{ success: false }`). */
  error(message: string, options: { rawResult?: boolean }): any;
}
