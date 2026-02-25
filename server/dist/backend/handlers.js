"use strict";
/**
 * Connection-level tool handlers — enable, disable, status, experimental features, reload.
 *
 * Each handler receives the ConnectionManagerAPI (mutable state), the tool arguments,
 * and an options object. Handlers return either MCP content responses (for MCP mode)
 * or raw JSON objects (for script mode via `rawResult: true`).
 *
 * State transitions managed here:
 *   - `onEnable`:  passive -> active (starts WebSocket, creates BrowserBridge)
 *   - `onDisable`: active/connected -> passive (tears down everything)
 *   - `onReloadMCP`: triggers exit code 42 for the debug wrapper to restart
 *
 * @module backend/handlers
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
exports.onEnable = onEnable;
exports.onDisable = onDisable;
exports.onStatus = onStatus;
exports.onExperimentalFeatures = onExperimentalFeatures;
exports.onReloadMCP = onReloadMCP;
const bridge_1 = require("../bridge");
const logger_1 = require("../logger");
const index_1 = require("../experimental/index");
const index_2 = require("../experimental/mouse-humanization/index");
const log = (0, logger_1.createLog)('[Conn]');
// Lazy-load BrowserBridge to break circular dependency (same pattern as backend.ts)
let BrowserBridge = null;
async function getBrowserBridge() {
    if (!BrowserBridge) {
        const mod = await Promise.resolve().then(() => __importStar(require('../tools')));
        BrowserBridge = mod.BrowserBridge;
    }
    return BrowserBridge;
}
// ─── Enable ──────────────────────────────────────────────────
/**
 * Activate browser automation: validate client_id, start WebSocket server,
 * create BrowserBridge, apply pre-enabled experiments from env.
 * Transitions state from passive to active.
 */
async function onEnable(mgr, args = {}, options = {}) {
    if (!args.client_id ||
        typeof args.client_id !== 'string' ||
        args.client_id.trim().length === 0) {
        if (options.rawResult) {
            return { success: false, error: 'missing_client_id', message: 'client_id is required' };
        }
        return {
            content: [
                {
                    type: 'text',
                    text: `### ⚠️ Missing Required Parameter\n\n\`client_id\` is required.\n\n**Example:**\n\`\`\`\nenable client_id='my-project'\n\`\`\``,
                },
            ],
            isError: true,
        };
    }
    if (mgr.state !== 'passive') {
        if (options.rawResult) {
            return {
                success: true,
                already_enabled: true,
                state: mgr.state,
                browser: mgr.connectedBrowserName,
                client_id: mgr.clientId,
            };
        }
        return {
            content: [
                {
                    type: 'text',
                    text: mgr.statusHeader() +
                        `### ✅ Already Enabled\n\n**State:** ${mgr.state}\n**Client ID:** ${mgr.clientId}\n\nTo restart, call \`disable\` first.`,
                },
            ],
        };
    }
    mgr.clientId = args.client_id.trim();
    log('Client ID set to:', mgr.clientId);
    // Start session log file
    const reg = (0, logger_1.getRegistry)();
    if (reg.debugMode) {
        const sessionLogger = reg.setSessionLog(mgr.clientId);
        log('Session log:', sessionLogger.logFilePath);
    }
    try {
        log('Starting extension server...');
        const port = mgr.config.port || 5555;
        if ((0, index_1.isInfraExperimentEnabled)('multiplexer', mgr.config)) {
            const { Multiplexer } = await Promise.resolve().then(() => __importStar(require('../experimental/multiplexer')));
            mgr.extensionServer = new Multiplexer(port, '127.0.0.1', mgr.clientId);
        }
        else {
            mgr.extensionServer = new bridge_1.ExtensionServer(port, '127.0.0.1');
        }
        await mgr.extensionServer.start();
        if (mgr.clientId) {
            mgr.extensionServer.notifyClientId(mgr.clientId);
        }
        // Handle extension reconnections
        mgr.extensionServer.onReconnect = () => {
            log('Extension reconnected, resetting tab state...');
            mgr.attachedTab = null;
            if (mgr.clientId) {
                mgr.extensionServer.notifyClientId(mgr.clientId);
            }
        };
        // Monitor tab info updates
        mgr.extensionServer.onTabInfoUpdate = (tabInfo) => {
            log('Tab info update:', tabInfo);
            if (tabInfo === null) {
                mgr.attachedTab = null;
                return;
            }
            if (mgr.attachedTab) {
                mgr.attachedTab = {
                    ...mgr.attachedTab,
                    id: tabInfo.id,
                    title: tabInfo.title,
                    url: tabInfo.url,
                    index: tabInfo.index,
                    techStack: tabInfo.techStack || null,
                };
            }
        };
        const BB = await getBrowserBridge();
        mgr.bridge = new BB(mgr.config, mgr.extensionServer);
        await mgr.bridge.initialize(mgr.server, mgr.clientInfo, mgr);
        mgr.state = 'active';
        mgr.connectedBrowserName = 'Local Browser';
        // Pre-enable session features from env var
        (0, index_1.applyInitialState)(mgr.config);
        // Notify MCP client that tool list changed
        mgr.notifyToolsListChanged().catch((err) => log('Error sending notification:', err));
        // Notify client about available experimental features
        mgr.sendLogNotification('info', 'SuperSurf experimental features available: page_diffing (reduces token cost by returning DOM diffs instead of full re-reads), smart_waiting (adaptive DOM stability detection), mouse_humanization (human-like cursor trajectories with overshoot correction). ' +
            'Use the experimental_features tool to toggle them, or set SUPERSURF_EXPERIMENTS=page_diffing,smart_waiting,mouse_humanization in your environment to pre-enable on startup.', 'experiments').catch(() => { });
        if (options.rawResult) {
            return {
                success: true,
                state: mgr.state,
                browser: mgr.connectedBrowserName,
                client_id: mgr.clientId,
                port: mgr.config.port || 5555,
            };
        }
        return {
            content: [
                {
                    type: 'text',
                    text: mgr.statusHeader() +
                        `### ✅ Browser Automation Activated!\n\n` +
                        `**State:** Active (waiting for extension)\n` +
                        `**Port:** ${port}\n\n` +
                        `**Next Steps:**\n` +
                        `1. Open the SuperSurf extension popup and enable it\n` +
                        `2. Call \`browser_tabs action='list'\` to see tabs\n` +
                        `3. Call \`browser_tabs action='attach' index=N\` to attach`,
                },
            ],
        };
    }
    catch (error) {
        log('Failed to start:', error);
        mgr.bridge = null;
        if (mgr.extensionServer) {
            await mgr.extensionServer.stop().catch(() => { });
            mgr.extensionServer = null;
        }
        mgr.state = 'passive';
        const port = mgr.config.port || 5555;
        const isPortError = error.message &&
            (error.message.includes('EADDRINUSE') || error.message.includes('address already in use'));
        if (options.rawResult) {
            return {
                success: false,
                error: isPortError ? 'port_in_use' : 'connection_failed',
                message: error.message,
                port,
            };
        }
        const errorMsg = isPortError
            ? `Port ${port} already in use. Disable MCP in other project or use --port <number>.`
            : `### Connection Failed\n\n${error.message}`;
        return { content: [{ type: 'text', text: errorMsg }], isError: true };
    }
}
// ─── Disable ─────────────────────────────────────────────────
/**
 * Deactivate browser automation: tear down bridge, stop WebSocket, reset
 * experiments and mouse humanization, transition back to passive.
 */
async function onDisable(mgr, options = {}) {
    if (mgr.state === 'passive') {
        if (options.rawResult) {
            return { success: true, already_disabled: true, state: 'passive' };
        }
        return {
            content: [
                {
                    type: 'text',
                    text: mgr.statusHeader() +
                        `### Already Disabled\n\nCall \`enable\` to activate.`,
                },
            ],
        };
    }
    log('Disconnecting...');
    if (mgr.bridge) {
        mgr.bridge.serverClosed();
        mgr.bridge = null;
    }
    if (mgr.extensionServer) {
        await mgr.extensionServer.stop();
        mgr.extensionServer = null;
    }
    // Close session log
    if (mgr.clientId) {
        (0, logger_1.getRegistry)().clearSessionLog(mgr.clientId);
    }
    mgr.state = 'passive';
    mgr.connectedBrowserName = null;
    mgr.attachedTab = null;
    (0, index_2.destroySession)('_default');
    index_1.experimentRegistry.reset();
    mgr.notifyToolsListChanged().catch((err) => log('Error sending notification:', err));
    if (options.rawResult) {
        return { success: true, state: 'passive' };
    }
    return {
        content: [
            {
                type: 'text',
                text: mgr.statusHeader() +
                    `### ✅ Disabled\n\nBrowser automation deactivated. Call \`enable\` to reactivate.`,
            },
        ],
    };
}
// ─── Status ──────────────────────────────────────────────────
/** Return current connection state, browser info, attached tab details, and multiplexer status (if enabled). */
async function onStatus(mgr, options = {}) {
    // Build multiplexer status if experiment is enabled
    let muxStatus = null;
    if ((0, index_1.isInfraExperimentEnabled)('multiplexer', mgr.config) && mgr.extensionServer) {
        const { Multiplexer } = await Promise.resolve().then(() => __importStar(require('../experimental/multiplexer')));
        if (mgr.extensionServer instanceof Multiplexer) {
            muxStatus = mgr.extensionServer.getStatus();
        }
    }
    const statusData = {
        state: mgr.state,
        browser: mgr.connectedBrowserName,
        client_id: mgr.clientId,
        attached_tab: mgr.attachedTab
            ? {
                index: mgr.attachedTab.index,
                title: mgr.attachedTab.title,
                url: mgr.attachedTab.url,
            }
            : null,
    };
    if (muxStatus) {
        statusData.multiplexer = muxStatus;
    }
    if (options.rawResult) {
        return statusData;
    }
    if (mgr.state === 'passive') {
        return {
            content: [
                {
                    type: 'text',
                    text: mgr.statusHeader() +
                        `### ❌ Disabled\n\nBrowser automation is not active. Call \`enable\` to activate.`,
                },
            ],
        };
    }
    let statusText = `### ✅ Enabled\n\n`;
    if (mgr.connectedBrowserName) {
        statusText += `**Browser:** ${mgr.connectedBrowserName}\n`;
    }
    if (mgr.attachedTab) {
        statusText += `**Tab:** #${mgr.attachedTab.index} — ${mgr.attachedTab.title || 'Untitled'}\n`;
        statusText += `**URL:** ${mgr.attachedTab.url || 'N/A'}\n\n`;
        statusText += `✅ Ready for automation!`;
    }
    else {
        statusText += `\n⚠️ No tab attached. Use \`browser_tabs action='attach' index=N\`.`;
    }
    if (muxStatus) {
        const roleLabel = muxStatus.role === 'leader' ? 'Leader' : 'Follower';
        statusText += `\n\n**Multiplexer:** ${roleLabel} (session: \`${muxStatus.session}\`)`;
        if (muxStatus.role === 'leader' && muxStatus.peers > 0) {
            statusText += ` | ${muxStatus.peers} peer(s)`;
        }
    }
    return {
        content: [{ type: 'text', text: mgr.statusHeader() + statusText }],
    };
}
// ─── Experimental Features ───────────────────────────────────
/**
 * Toggle experimental features. With no recognized keys, lists current states.
 * For mouse_humanization, also initializes/destroys the humanization session
 * and notifies the extension.
 */
async function onExperimentalFeatures(mgr, args = {}, options = {}) {
    const keys = Object.keys(args).filter(k => index_1.experimentRegistry.listAvailable().includes(k));
    if (keys.length === 0) {
        const states = index_1.experimentRegistry.getStates();
        if (options.rawResult) {
            return { success: true, experiments: states, available: index_1.experimentRegistry.listAvailable() };
        }
        return {
            content: [{
                    type: 'text',
                    text: mgr.statusHeader() +
                        `### Experimental Features\n\n` +
                        Object.entries(states).map(([k, v]) => `- **${k}**: ${v ? 'enabled' : 'disabled'}`).join('\n') +
                        `\n\nPass \`{ "feature_name": true/false }\` to toggle.`,
                }],
        };
    }
    for (const key of keys) {
        const value = args[key];
        if (value === true) {
            index_1.experimentRegistry.enable(key);
            if (key === 'mouse_humanization') {
                (0, index_2.initSession)('_default');
                if (mgr.extensionServer) {
                    mgr.extensionServer.sendCmd('setHumanizationConfig', { enabled: true }).catch(() => { });
                }
            }
        }
        else if (value === false) {
            index_1.experimentRegistry.disable(key);
            if (key === 'mouse_humanization') {
                (0, index_2.destroySession)('_default');
                if (mgr.extensionServer) {
                    mgr.extensionServer.sendCmd('setHumanizationConfig', { enabled: false }).catch(() => { });
                }
            }
        }
    }
    const states = index_1.experimentRegistry.getStates();
    if (options.rawResult) {
        return { success: true, experiments: states };
    }
    return {
        content: [{
                type: 'text',
                text: mgr.statusHeader() +
                    `### Experimental Features Updated\n\n` +
                    Object.entries(states).map(([k, v]) => `- **${k}**: ${v ? 'enabled' : 'disabled'}`).join('\n'),
            }],
    };
}
// ─── Reload (debug) ──────────────────────────────────────────
/** Trigger hot reload by exiting with code 42. The debug wrapper catches this and respawns. */
function onReloadMCP(mgr, options = {}) {
    if (!mgr.debugMode) {
        return {
            content: [{ type: 'text', text: 'reload_mcp only available in debug mode.' }],
            isError: true,
        };
    }
    if (options.rawResult) {
        setTimeout(() => process.exit(42), 100);
        return { success: true, message: 'Reloading...' };
    }
    setTimeout(() => process.exit(42), 100);
    return {
        content: [{ type: 'text', text: '🔄 Reloading MCP server...' }],
    };
}
//# sourceMappingURL=handlers.js.map