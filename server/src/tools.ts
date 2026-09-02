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
import type { ToolSchema, ToolContext } from './tools/lib/types';
import { createLog } from './logger';
import { UsageMetricsLogger } from './usage-metrics-logger';
import { getExperimentalToolSchemas, experimentRegistry } from './experimental/index';
import { resolveWithHealing, captureInContext, healInContext, domainOf, routeOf } from './experimental/fingerprinting/index';
import { resolveSelectorOrHandle } from './experimental/fingerprinting/handle-resolve';
import { buildHandleIndex } from './experimental/fingerprinting/handle-annotate';
import { selectorFromHit } from './experimental/fingerprinting/selector-synthesis';

import { getToolSchemas } from './tools/schemas';
import { cdp as cdpFn, evalExpr as evalFn } from './tools/lib/cdp';
import {
  getElementCenter,
  getSelectorExpression,
  findAlternativeSelectors,
} from './tools/lib/element-resolver';
import { formatResult, formatError } from './tools/lib/result-formatter';
import { dispatchTool } from './tools/lib/dispatcher';

const log = createLog('[Bridge]');

/**
 * Lifecycle wrapper for browser tool execution. Created by
 * `backend/handlers.ts:onConnect` after the daemon transport is up;
 * `initialize()` wires in the MCP server, client metadata, connection
 * manager, and (optional) usage-metrics logger.
 */
export class BrowserBridge {
  private config: any;
  private ext: IExtensionTransport | null;
  private server: any = null;
  private clientInfo: any = {};
  private connectionManager: any = null;
  private metricsLogger: UsageMetricsLogger | null = null;

  constructor(config: any, ext: IExtensionTransport | null) {
    this.config = config;
    this.ext = ext;
  }

  async initialize(
    server: any,
    clientInfo: any,
    connectionManager?: any,
    metricsLogger?: UsageMetricsLogger | null,
  ): Promise<void> {
    this.server = server;
    this.clientInfo = clientInfo;
    this.connectionManager = connectionManager;
    this.metricsLogger = metricsLogger ?? null;
  }

  serverClosed(): void {
    log('Server closed');
  }

  /** Return all registered tool schemas (core + experimental). */
  async listTools(): Promise<ToolSchema[]> {
    return [...getToolSchemas(), ...getExperimentalToolSchemas()];
  }

  /**
   * Build the ToolContext that handlers receive.
   *
   * `tabId` (from the caller's `tabId` arg) is baked into `cdp`/`eval`/
   * `getElementCenter` so the entire selector/eval/CDP surface targets one
   * tab — concurrency isolation for parallel callers sharing a session.
   */
  private buildContext(tabId?: number): ToolContext {
    const ext = this.ext!;
    const evalFnBound = (expression: string, awaitPromise = true) =>
      evalFn(ext, expression, awaitPromise, tabId);
    // Handle→selector translation. Synchronous and idempotent; a plain CSS selector
    // costs one regex test. Gate + store access live in the experimental module —
    // this is the thin delegation hook.
    const resolveSelectorSync = (selector: string): string =>
      resolveSelectorOrHandle(this.connectionManager?.getAttachedTab()?.url, selector).selector;
    const emitHandle = (ev: import('./experimental/fingerprinting/index').AnyHandleEvent) =>
      this.metricsLogger?.write({
        session_id: this.connectionManager?.clientId ?? 'unknown',
        tool: 'handle',
        params: ev as unknown as Record<string, unknown>,
        result: 'ok',
        duration_ms: 0,
      });
    return {
      ext,
      connectionManager: this.connectionManager,
      config: this.config?.configService,
      metricsLogger: this.metricsLogger,
      tabId,
      cdp: (method, params) => cdpFn(ext, method, params, tabId),
      eval: evalFnBound,
      sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
      getElementCenter: (selector: string, meta?: import('./experimental/fingerprinting/handle-meta').HandleMeta) =>
        resolveWithHealing(
          evalFnBound,
          selector,
          () => this.connectionManager?.getAttachedTab()?.url,
          (ev) =>
            this.metricsLogger?.write({
              session_id: this.connectionManager?.clientId ?? 'unknown',
              tool: 'fingerprint',
              params: ev as unknown as Record<string, unknown>,
              result: 'ok',
              duration_ms: 0,
            }),
          meta,
          emitHandle,
        ),
      captureFingerprintInContext: (contextId: number | null, selector: string, meta?: import('./experimental/fingerprinting/handle-meta').HandleMeta) =>
        void captureInContext(
          (expr: string) => {
            const params: any = { expression: expr, returnByValue: true };
            if (contextId != null) params.contextId = contextId; // null => top-frame default context
            return cdpFn(ext, 'Runtime.evaluate', params, tabId).then((r: any) => r.result?.value);
          },
          this.connectionManager?.getAttachedTab()?.url,
          selector,
          meta,
          emitHandle,
        ),
      healFingerprintInContext: (contextId: number | null, selector: string) =>
        healInContext(
          (expr: string) => {
            const params: any = { expression: expr, returnByValue: true };
            if (contextId != null) params.contextId = contextId; // null => top-frame default context
            return cdpFn(ext, 'Runtime.evaluate', params, tabId).then((r: any) => r.result?.value);
          },
          this.connectionManager?.getAttachedTab()?.url,
          selector,
        ).then(async (hit) => {
          if (!hit) return null;
          const url = this.connectionManager?.getAttachedTab()?.url;
          this.metricsLogger?.write({
            session_id: this.connectionManager?.clientId ?? 'unknown',
            tool: 'fingerprint',
            params: {
              event: 'fingerprint', outcome: 'healed',
              selector, domain: domainOf(url), route: routeOf(url),
              score: hit.score, margin: hit.margin, hadRecord: true, discovery: 'known',
            } as unknown as Record<string, unknown>,
            result: 'ok',
            duration_ms: 0,
          });
          // Best-effort: re-resolve a live element for the winning hit so callers
          // that need more than coordinates (every selector-resolving verb besides
          // click/hover/drag) can act on it. Synthesize a selector from the winner's
          // stable identity first — robust to overlapping/hidden elements (e.g. a
          // styled label sitting on top of a file input) — falling back to
          // `elementFromPoint` at the winning coordinates. Failure here only omits
          // `objectId`/`resolvedExpr`; the coordinate-only heal above is unaffected.
          const synthesized = selectorFromHit(hit);
          const objectExpr = synthesized ? getSelectorExpression(synthesized) : `document.elementFromPoint(${hit.cx}, ${hit.cy})`;
          const objParams: any = { expression: objectExpr, returnByValue: false };
          if (contextId != null) objParams.contextId = contextId;
          let objectId: string | undefined;
          try {
            const r = await cdpFn(ext, 'Runtime.evaluate', objParams, tabId);
            objectId = r?.result?.objectId;
          } catch { /* best-effort */ }
          return objectId
            ? { cx: hit.cx, cy: hit.cy, score: hit.score, objectId, resolvedExpr: objectExpr }
            : { cx: hit.cx, cy: hit.cy, score: hit.score };
        }),
      resolveSelector: resolveSelectorSync,
      getHandleIndex: () => buildHandleIndex(this.connectionManager?.getAttachedTab()?.url),
      getSelectorExpression: (selector: string) => getSelectorExpression(resolveSelectorSync(selector)),
      findAlternativeSelectors: (selector: string) => findAlternativeSelectors(evalFnBound, selector),
      formatResult: (name, result, options) =>
        formatResult(name, result, options, this.connectionManager),
      error: (message, options) => formatError(message, options),
    };
  }

  /**
   * Dispatch a named tool call. Short-circuits with a help-text error
   * when the extension transport is missing, otherwise forwards to
   * `dispatchTool`.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: { rawResult?: boolean } = {},
  ): Promise<any> {
    if (!this.ext) {
      const response = formatError(
        'Extension not connected.\n\n' +
        '**The extension typically auto-connects within a few seconds after calling `connect`. Wait a moment and retry this tool call.**\n\n' +
        '**If the issue persists:**\n' +
        '1. Run `npx supersurf-daemon@latest status` to check if the daemon is running\n' +
        '2. Ensure the SuperSurf extension is loaded in Chrome (`chrome://extensions`)\n' +
        '3. Open the extension popup and verify it shows "Connected"',
        options,
      );
      this.metricsLogger?.write({
        session_id: this.connectionManager?.clientId ?? 'unknown',
        tool: name,
        params: args,
        result: 'error',
        error: 'Extension not connected',
        experiments: experimentRegistry.getStates(),
        duration_ms: 0,
      });
      return response;
    }

    return await dispatchTool(this.buildContext(args.tabId as number | undefined), name, args, options, {
      metricsLogger: this.metricsLogger,
      clientId: this.connectionManager?.clientId,
      getCurrentUrl: () => this.connectionManager?.getAttachedTab()?.url,
    });
  }
}
