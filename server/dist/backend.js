"use strict";
/**
 * ConnectionManager — central state machine for the server's connection lifecycle.
 *
 * States:
 *   - **passive** — server is idle, only connection tools (connect/disconnect/status) are available
 *   - **active** — connected to daemon, waiting for extension
 *   - **connected** — extension linked via daemon, all browser tools available
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionManager = void 0;
const usage_metrics_logger_1 = require("./usage-metrics-logger");
const logger_1 = require("./logger");
const status_1 = require("./backend/status");
const schemas_1 = require("./backend/schemas");
const handlers_1 = require("./backend/handlers");
const log = (0, logger_1.createLog)('[Conn]');
// Lazy-load BrowserBridge to avoid circular dependency: tools.ts imports types from backend
let BrowserBridge = null;
/** Lazy singleton loader for BrowserBridge class. */
async function getBrowserBridge() {
    if (!BrowserBridge) {
        const mod = await Promise.resolve().then(() => __importStar(require('./tools')));
        BrowserBridge = mod.BrowserBridge;
    }
    return BrowserBridge;
}
/**
 * Core state machine for managing the extension connection lifecycle.
 * Implements ConnectionManagerAPI so handler functions can read/write state.
 */
class ConnectionManager {
    config;
    state = 'passive';
    bridge = null;
    extensionServer = null;
    debugMode;
    clientId = null;
    connectedBrowserName = null;
    attachedTab = null;
    stealthMode = false;
    metricsLogger = null;
    server = null;
    clientInfo = {};
    constructor(config) {
        log('Constructor — starting in PASSIVE mode');
        this.config = config;
        this.debugMode = config.debug || false;
    }
    /** Store server reference and client metadata. Does not start the WebSocket — that happens in `enable`. */
    async initialize(server, clientInfo) {
        log('Initialize called — staying in passive mode');
        this.server = server;
        this.clientInfo = clientInfo;
    }
    // ─── Status header ─────────────────────────────────────────
    /** Build a one-line status string prepended to every tool response. */
    statusHeader() {
        return (0, status_1.buildStatusHeader)({
            config: this.config,
            state: this.state,
            debugMode: this.debugMode,
            connectedBrowserName: this.connectedBrowserName,
            attachedTab: this.attachedTab,
            stealthMode: this.stealthMode,
            extensionServer: this.extensionServer,
        });
    }
    // ─── Tool listing ──────────────────────────────────────────
    /** Return all available tool schemas: connection tools + browser tools + debug tools (if enabled). */
    async listTools() {
        log(`listTools() — state: ${this.state}`);
        const connectionTools = (0, schemas_1.getConnectionToolSchemas)();
        // Get browser tools from BrowserBridge (dummy transport, schema only)
        const BB = await getBrowserBridge();
        const dummyBridge = new BB(this.config, null);
        const browserTools = await dummyBridge.listTools();
        const debugTools = [];
        if (this.debugMode) {
            debugTools.push((0, schemas_1.getDebugToolSchema)());
        }
        const profileTools = (0, schemas_1.getProfileToolSchemas)();
        return [...connectionTools, ...browserTools, ...profileTools, ...debugTools];
    }
    // ─── Tool dispatch ─────────────────────────────────────────
    /**
     * Dispatch a tool call. Connection tools are handled locally; browser tools
     * forward to BrowserBridge. Returns MCP content response or raw JSON (script mode).
     * @param rawResult - When true, return plain objects instead of MCP content wrappers
     */
    async callTool(name, rawArguments = {}, options = {}) {
        log(`callTool(${name}) — state: ${this.state}`);
        // Deprecation stub for experimental_features (removed in v2.0.0).
        // Returns a clear error pointing the agent at the new config file.
        if (name === 'experimental_features') {
            if (options.rawResult) {
                return {
                    success: false,
                    error: 'removed',
                    message: 'experimental_features was removed in v2.0.0 — edit ~/.supersurf/config.json instead',
                };
            }
            return {
                content: [{
                        type: 'text',
                        text: '### Tool removed in v2.0.0\n\n`experimental_features` was retired. Edit `~/.supersurf/config.json` (auto-scaffolded on first daemon start) and restart the daemon.',
                    }],
                isError: true,
            };
        }
        const start = Date.now();
        const BACKEND_TOOLS = new Set([
            'connect', 'disconnect', 'status', 'reload_mcp',
            'profile_create', 'profile_list', 'profile_delete',
        ]);
        if (BACKEND_TOOLS.has(name)) {
            // Create metrics logger on connect, gated by config.logging.usage_metrics.
            // The logger captures the connect call itself, so this must run before the handler.
            const metricsEnabled = this.config.configService?.get().logging.usage_metrics ?? false;
            if (name === 'connect' && !this.metricsLogger && rawArguments.client_id && metricsEnabled) {
                this.metricsLogger = new usage_metrics_logger_1.UsageMetricsLogger(String(rawArguments.client_id));
            }
            let result;
            try {
                switch (name) {
                    case 'connect':
                        result = await (0, handlers_1.onConnect)(this, rawArguments, options);
                        break;
                    case 'disconnect':
                        result = await (0, handlers_1.onDisconnect)(this, options);
                        break;
                    case 'status':
                        result = await (0, handlers_1.onStatus)(this, options);
                        break;
                    case 'reload_mcp':
                        result = (0, handlers_1.onReloadMCP)(this, options);
                        break;
                    case 'profile_create':
                    case 'profile_list':
                    case 'profile_delete': {
                        // Profile tools handle their own daemon connection — no connect() required
                        if (name === 'profile_create')
                            result = await (0, handlers_1.onProfileCreate)(this, rawArguments, options);
                        else if (name === 'profile_list')
                            result = await (0, handlers_1.onProfileList)(this, options);
                        else
                            result = await (0, handlers_1.onProfileDelete)(this, rawArguments, options);
                        break;
                    }
                }
                // Usage-metrics log the backend tool call
                const isError = result?.isError === true || result?.success === false;
                const entry = {
                    session_id: this.clientId || 'unknown',
                    tool: name,
                    params: rawArguments,
                    result: isError ? 'error' : 'ok',
                    duration_ms: Date.now() - start,
                };
                if (this.attachedTab?.url) {
                    entry.url = this.attachedTab.url;
                }
                if (isError) {
                    entry.error = result?.error || result?.content?.[0]?.text || 'unknown error';
                }
                if (name === 'connect' && this.clientInfo) {
                    const ci = this.clientInfo;
                    if (ci.name || ci.version) {
                        entry.client = {
                            name: String(ci.name || 'unknown'),
                            version: String(ci.version || 'unknown'),
                        };
                    }
                }
                this.metricsLogger?.write(entry);
                return result;
            }
            catch (err) {
                // Usage-metrics log the error
                const entry = {
                    session_id: this.clientId || 'unknown',
                    tool: name,
                    params: rawArguments,
                    result: 'error',
                    error: err?.message || String(err),
                    duration_ms: Date.now() - start,
                };
                if (name === 'connect' && this.clientInfo) {
                    const ci = this.clientInfo;
                    if (ci.name || ci.version) {
                        entry.client = {
                            name: String(ci.name || 'unknown'),
                            version: String(ci.version || 'unknown'),
                        };
                    }
                }
                this.metricsLogger?.write(entry);
                throw err;
            }
        }
        // Forward to active bridge
        if (!this.bridge) {
            if (options.rawResult) {
                return {
                    success: false,
                    error: 'not_enabled',
                    message: 'Browser automation not active. Call connect first.',
                };
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: `### Browser Automation Not Active\n\n**Current State:** Passive (disconnected)\n\n**You must call \`connect\` first to activate browser automation.** The daemon auto-starts and the extension connects within seconds — then retry your tool call.`,
                    },
                ],
                isError: true,
            };
        }
        return await this.bridge.callTool(name, rawArguments, options);
    }
    // ─── Notify tools changed ──────────────────────────────────
    /** Signal MCP client that the available tool list has changed (e.g., after enable/disable). */
    async notifyToolsListChanged() {
        if (this.server) {
            try {
                await this.server.sendToolsListChanged?.();
            }
            catch {
                // Client may not support this notification
            }
        }
    }
    // ─── Logging notifications ───────────────────────────────
    /** Send an MCP logging notification to the client (info, warn, error). Silently no-ops if unsupported. */
    async sendLogNotification(level, message, logger) {
        if (this.server) {
            try {
                const hasMethod = typeof this.server.sendLoggingMessage === 'function';
                log(`sendLogNotification: hasMethod=${hasMethod}, level=${level}, logger=${logger || 'supersurf'}`);
                if (hasMethod) {
                    await this.server.sendLoggingMessage({
                        level,
                        logger: logger || 'supersurf',
                        data: message,
                    });
                    log('sendLogNotification: sent successfully');
                }
                else {
                    log('sendLogNotification: method not found on server instance');
                }
            }
            catch (err) {
                log('sendLogNotification error:', err?.message || err);
            }
        }
        else {
            log('sendLogNotification: no server instance');
        }
    }
    // ─── Public accessors for BrowserBridge to update state ────
    setAttachedTab(tab) {
        this.attachedTab = tab;
    }
    getAttachedTab() {
        return this.attachedTab;
    }
    clearAttachedTab() {
        this.attachedTab = null;
    }
    setConnectedBrowserName(name) {
        this.connectedBrowserName = name;
    }
    setStealthMode(enabled) {
        this.stealthMode = enabled;
    }
    // ─── Shutdown ──────────────────────────────────────────────
    /** Tear down bridge, stop WebSocket server, reset to passive. Called on SIGINT or explicit shutdown. */
    async serverClosed() {
        log('Server closed');
        if (this.bridge) {
            this.bridge.serverClosed();
            this.bridge = null;
        }
        if (this.extensionServer) {
            await this.extensionServer.stop();
            this.extensionServer = null;
        }
        this.state = 'passive';
    }
}
exports.ConnectionManager = ConnectionManager;
//# sourceMappingURL=backend.js.map