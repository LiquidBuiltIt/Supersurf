"use strict";
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
        return [...connectionTools, ...browserTools, ...debugTools];
    }
    // ─── Tool dispatch ─────────────────────────────────────────
    /**
     * Dispatch a tool call. Connection tools are handled locally; browser tools
     * forward to BrowserBridge. Returns MCP content response or raw JSON (script mode).
     * @param rawResult - When true, return plain objects instead of MCP content wrappers
     */
    async callTool(name, rawArguments = {}, options = {}) {
        log(`callTool(${name}) — state: ${this.state}`);
        switch (name) {
            case 'enable':
                return await (0, handlers_1.onEnable)(this, rawArguments, options);
            case 'disable':
                return await (0, handlers_1.onDisable)(this, options);
            case 'status':
                return await (0, handlers_1.onStatus)(this, options);
            case 'experimental_features':
                return await (0, handlers_1.onExperimentalFeatures)(this, rawArguments, options);
            case 'reload_mcp':
                return (0, handlers_1.onReloadMCP)(this, options);
        }
        // Forward to active bridge
        if (!this.bridge) {
            if (options.rawResult) {
                return {
                    success: false,
                    error: 'not_enabled',
                    message: 'Browser automation not active. Call enable first.',
                };
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: `### ⚠️ Browser Automation Not Active\n\n**Current State:** Passive (disabled)\n\n**You must call \`enable\` first to activate browser automation.** After calling \`enable\`, the extension auto-connects within a few seconds — then retry your tool call.`,
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