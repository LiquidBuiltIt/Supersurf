"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserBridge = void 0;
const logger_1 = require("./logger");
const index_1 = require("./experimental/index");
const index_2 = require("./experimental/fingerprinting/index");
const handle_resolve_1 = require("./experimental/fingerprinting/handle-resolve");
const handle_annotate_1 = require("./experimental/fingerprinting/handle-annotate");
const schemas_1 = require("./tools/schemas");
const cdp_1 = require("./tools/lib/cdp");
const element_resolver_1 = require("./tools/lib/element-resolver");
const result_formatter_1 = require("./tools/lib/result-formatter");
const dispatcher_1 = require("./tools/lib/dispatcher");
const log = (0, logger_1.createLog)('[Bridge]');
/**
 * Lifecycle wrapper for browser tool execution. Created by
 * `backend/handlers.ts:onConnect` after the daemon transport is up;
 * `initialize()` wires in the MCP server, client metadata, connection
 * manager, and (optional) usage-metrics logger.
 */
class BrowserBridge {
    config;
    ext;
    server = null;
    clientInfo = {};
    connectionManager = null;
    metricsLogger = null;
    constructor(config, ext) {
        this.config = config;
        this.ext = ext;
    }
    async initialize(server, clientInfo, connectionManager, metricsLogger) {
        this.server = server;
        this.clientInfo = clientInfo;
        this.connectionManager = connectionManager;
        this.metricsLogger = metricsLogger ?? null;
    }
    serverClosed() {
        log('Server closed');
    }
    /** Return all registered tool schemas (core + experimental). */
    async listTools() {
        return [...(0, schemas_1.getToolSchemas)(), ...(0, index_1.getExperimentalToolSchemas)()];
    }
    /**
     * Build the ToolContext that handlers receive.
     *
     * `tabId` (from the caller's `tabId` arg) is baked into `cdp`/`eval`/
     * `getElementCenter` so the entire selector/eval/CDP surface targets one
     * tab — concurrency isolation for parallel callers sharing a session.
     */
    buildContext(tabId) {
        const ext = this.ext;
        const evalFnBound = (expression, awaitPromise = true) => (0, cdp_1.evalExpr)(ext, expression, awaitPromise, tabId);
        // Handle→selector translation. Synchronous and idempotent; a plain CSS selector
        // costs one regex test. Gate + store access live in the experimental module —
        // this is the thin delegation hook.
        const resolveSelectorSync = (selector) => (0, handle_resolve_1.resolveSelectorOrHandle)(this.connectionManager?.getAttachedTab()?.url, selector).selector;
        const emitHandle = (ev) => this.metricsLogger?.write({
            session_id: this.connectionManager?.clientId ?? 'unknown',
            tool: 'handle',
            params: ev,
            result: 'ok',
            duration_ms: 0,
        });
        return {
            ext,
            connectionManager: this.connectionManager,
            config: this.config?.configService,
            metricsLogger: this.metricsLogger,
            tabId,
            cdp: (method, params) => (0, cdp_1.cdp)(ext, method, params, tabId),
            eval: evalFnBound,
            sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
            getElementCenter: (selector, meta) => (0, index_2.resolveWithHealing)(evalFnBound, selector, () => this.connectionManager?.getAttachedTab()?.url, (ev) => this.metricsLogger?.write({
                session_id: this.connectionManager?.clientId ?? 'unknown',
                tool: 'fingerprint',
                params: ev,
                result: 'ok',
                duration_ms: 0,
            }), meta, emitHandle),
            captureFingerprintInContext: (contextId, selector, meta) => void (0, index_2.captureInContext)((expr) => {
                const params = { expression: expr, returnByValue: true };
                if (contextId != null)
                    params.contextId = contextId; // null => top-frame default context
                return (0, cdp_1.cdp)(ext, 'Runtime.evaluate', params, tabId).then((r) => r.result?.value);
            }, this.connectionManager?.getAttachedTab()?.url, selector, meta, emitHandle),
            healFingerprintInContext: (contextId, selector) => (0, index_2.healInContext)((expr) => (0, cdp_1.cdp)(ext, 'Runtime.evaluate', { expression: expr, contextId, returnByValue: true }, tabId)
                .then((r) => r.result?.value), this.connectionManager?.getAttachedTab()?.url, selector).then((hit) => {
                if (!hit)
                    return null;
                const url = this.connectionManager?.getAttachedTab()?.url;
                this.metricsLogger?.write({
                    session_id: this.connectionManager?.clientId ?? 'unknown',
                    tool: 'fingerprint',
                    params: {
                        event: 'fingerprint', outcome: 'healed',
                        selector, domain: (0, index_2.domainOf)(url), route: (0, index_2.routeOf)(url),
                        score: hit.score, margin: hit.margin, hadRecord: true, discovery: 'known',
                    },
                    result: 'ok',
                    duration_ms: 0,
                });
                return { cx: hit.cx, cy: hit.cy, score: hit.score };
            }),
            resolveSelector: resolveSelectorSync,
            getHandleIndex: () => (0, handle_annotate_1.buildHandleIndex)(this.connectionManager?.getAttachedTab()?.url),
            getSelectorExpression: (selector) => (0, element_resolver_1.getSelectorExpression)(resolveSelectorSync(selector)),
            findAlternativeSelectors: (selector) => (0, element_resolver_1.findAlternativeSelectors)(evalFnBound, selector),
            formatResult: (name, result, options) => (0, result_formatter_1.formatResult)(name, result, options, this.connectionManager),
            error: (message, options) => (0, result_formatter_1.formatError)(message, options),
        };
    }
    /**
     * Dispatch a named tool call. Short-circuits with a help-text error
     * when the extension transport is missing, otherwise forwards to
     * `dispatchTool`.
     */
    async callTool(name, args = {}, options = {}) {
        if (!this.ext) {
            const response = (0, result_formatter_1.formatError)('Extension not connected.\n\n' +
                '**The extension typically auto-connects within a few seconds after calling `connect`. Wait a moment and retry this tool call.**\n\n' +
                '**If the issue persists:**\n' +
                '1. Run `npx supersurf-daemon status` to check if the daemon is running\n' +
                '2. Ensure the SuperSurf extension is loaded in Chrome (`chrome://extensions`)\n' +
                '3. Open the extension popup and verify it shows "Connected"', options);
            this.metricsLogger?.write({
                session_id: this.connectionManager?.clientId ?? 'unknown',
                tool: name,
                params: args,
                result: 'error',
                error: 'Extension not connected',
                experiments: index_1.experimentRegistry.getStates(),
                duration_ms: 0,
            });
            return response;
        }
        return await (0, dispatcher_1.dispatchTool)(this.buildContext(args.tabId), name, args, options, {
            metricsLogger: this.metricsLogger,
            clientId: this.connectionManager?.clientId,
            getCurrentUrl: () => this.connectionManager?.getAttachedTab()?.url,
        });
    }
}
exports.BrowserBridge = BrowserBridge;
//# sourceMappingURL=tools.js.map