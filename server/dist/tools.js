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
    /** Build the ToolContext that handlers receive. */
    buildContext() {
        const ext = this.ext;
        const evalFnBound = (expression, awaitPromise = true) => (0, cdp_1.evalExpr)(ext, expression, awaitPromise);
        return {
            ext,
            connectionManager: this.connectionManager,
            config: this.config?.configService,
            cdp: (method, params) => (0, cdp_1.cdp)(ext, method, params),
            eval: evalFnBound,
            sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
            getElementCenter: (selector) => (0, element_resolver_1.getElementCenter)(evalFnBound, selector),
            getSelectorExpression: element_resolver_1.getSelectorExpression,
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
        return await (0, dispatcher_1.dispatchTool)(this.buildContext(), name, args, options, {
            metricsLogger: this.metricsLogger,
            clientId: this.connectionManager?.clientId,
            getCurrentUrl: () => this.connectionManager?.getAttachedTab()?.url,
        });
    }
}
exports.BrowserBridge = BrowserBridge;
//# sourceMappingURL=tools.js.map