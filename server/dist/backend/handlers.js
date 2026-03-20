"use strict";
/**
 * Connection-level tool handlers — connect, disconnect, status, experimental features, reload.
 *
 * Each handler receives the ConnectionManagerAPI (mutable state), the tool arguments,
 * and an options object. Handlers return either MCP content responses (for MCP mode)
 * or raw JSON objects (for script mode via `rawResult: true`).
 *
 * State transitions managed here:
 *   - `onConnect`:  passive -> active (spawns daemon, connects via DaemonClient, creates BrowserBridge)
 *   - `onDisconnect`: active/connected -> passive (closes daemon session)
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
exports.onConnect = onConnect;
exports.onDisconnect = onDisconnect;
exports.onStatus = onStatus;
exports.onExperimentalFeatures = onExperimentalFeatures;
exports.onProfileCreate = onProfileCreate;
exports.onProfileList = onProfileList;
exports.onProfileDelete = onProfileDelete;
exports.onReloadMCP = onReloadMCP;
const daemon_client_1 = require("../daemon-client");
const daemon_spawn_1 = require("../daemon-spawn");
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
// ─── Connect ──────────────────────────────────────────────────
/**
 * Connect to the SuperSurf daemon: validate client_id, spawn daemon if needed,
 * connect via DaemonClient, create BrowserBridge, apply pre-enabled experiments.
 * Transitions state from passive to active.
 */
async function onConnect(mgr, args = {}, options = {}) {
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
                    text: `### Missing Required Parameter\n\n\`client_id\` is required.\n\n**Example:**\n\`\`\`\nconnect client_id='my-project'\n\`\`\``,
                },
            ],
            isError: true,
        };
    }
    if (mgr.state !== 'passive') {
        if (options.rawResult) {
            return {
                success: true,
                already_connected: true,
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
                        `### Already Connected\n\n**State:** ${mgr.state}\n**Client ID:** ${mgr.clientId}\n\nTo restart, call \`disconnect\` first.`,
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
        const port = mgr.config.port || 5555;
        // Spawn daemon if not running
        log('Ensuring daemon is running...');
        await (0, daemon_spawn_1.ensureDaemon)(port, mgr.debugMode, mgr.config.enabledExperiments || []);
        // Connect to daemon via Unix socket
        const sockPath = (0, daemon_spawn_1.getSockPath)();
        const client = new daemon_client_1.DaemonClient(sockPath, mgr.clientId);
        await client.start();
        mgr.extensionServer = client;
        // Handle extension reconnections
        mgr.extensionServer.onReconnect = () => {
            log('Extension reconnected, resetting tab state...');
            mgr.attachedTab = null;
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
        // Bind experiment registry to daemon transport
        index_1.experimentRegistry.bind(client);
        const BB = await getBrowserBridge();
        mgr.bridge = new BB(mgr.config, mgr.extensionServer);
        await mgr.bridge.initialize(mgr.server, mgr.clientInfo, mgr);
        mgr.state = 'active';
        mgr.connectedBrowserName = client.browser;
        // Store daemon capabilities
        mgr.daemonCapabilities = client.capabilities;
        // Connect to a managed profile if requested
        if (args.profile && typeof args.profile === 'string') {
            log('Connecting to profile:', args.profile);
            await client.sendCmd('profiles.connect', { profile: args.profile }, 90000);
        }
        // Pre-enable session features from env var (fire-and-forget IPC to daemon)
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
                port,
            };
        }
        return {
            content: [
                {
                    type: 'text',
                    text: mgr.statusHeader() +
                        `### Connected to Service\n\n` +
                        `**State:** Active\n` +
                        `**Browser:** ${mgr.connectedBrowserName}\n\n` +
                        `**Next Steps:**\n` +
                        `1. Call \`browser_tabs action='list'\` to see tabs\n` +
                        `2. Call \`browser_tabs action='attach' index=N\` to attach\n\n` +
                        `**Skill guide:** https://liquidbuiltit.github.io/Supersurf/skill.md`,
                },
            ],
        };
    }
    catch (error) {
        log('Failed to connect:', error);
        mgr.bridge = null;
        if (mgr.extensionServer) {
            await mgr.extensionServer.stop().catch(() => { });
            mgr.extensionServer = null;
        }
        mgr.state = 'passive';
        if (options.rawResult) {
            return {
                success: false,
                error: 'connection_failed',
                message: error.message,
            };
        }
        return {
            content: [{ type: 'text', text: `### Connection Failed\n\n${error.message}` }],
            isError: true,
        };
    }
}
// ─── Disconnect ─────────────────────────────────────────────────
/**
 * Disconnect from the daemon: tear down bridge, close DaemonClient session,
 * reset experiments and mouse humanization, transition back to passive.
 * The daemon stays alive for other sessions.
 */
async function onDisconnect(mgr, options = {}) {
    if (mgr.state === 'passive') {
        if (options.rawResult) {
            return { success: true, already_disconnected: true, state: 'passive' };
        }
        return {
            content: [
                {
                    type: 'text',
                    text: mgr.statusHeader() +
                        `### Already Disconnected\n\nNot connected to service. Call \`connect\` to activate.`,
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
    index_1.experimentRegistry.unbind();
    mgr.notifyToolsListChanged().catch((err) => log('Error sending notification:', err));
    if (options.rawResult) {
        return { success: true, state: 'passive' };
    }
    return {
        content: [
            {
                type: 'text',
                text: mgr.statusHeader() +
                    `### Disconnected from Service\n\nSession closed. Call \`connect\` to reconnect.`,
            },
        ],
    };
}
// ─── Status ──────────────────────────────────────────────────
/** Return current connection state, browser info, and attached tab details. */
async function onStatus(mgr, options = {}) {
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
    if (options.rawResult) {
        return statusData;
    }
    if (mgr.state === 'passive') {
        return {
            content: [
                {
                    type: 'text',
                    text: mgr.statusHeader() +
                        `### Disconnected\n\nNot connected to service. Call \`connect\` to activate.`,
                },
            ],
        };
    }
    let statusText = `### Connected to Service\n\n`;
    if (mgr.connectedBrowserName) {
        statusText += `**Browser:** ${mgr.connectedBrowserName}\n`;
    }
    if (mgr.attachedTab) {
        statusText += `**Tab:** #${mgr.attachedTab.index} — ${mgr.attachedTab.title || 'Untitled'}\n`;
        statusText += `**URL:** ${mgr.attachedTab.url || 'N/A'}\n\n`;
        statusText += `Ready for automation!`;
    }
    else {
        statusText += `\nNo tab attached. Use \`browser_tabs action='attach' index=N\`.`;
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
        if (typeof value === 'boolean') {
            await index_1.experimentRegistry.toggle(key, value);
            if (key === 'mouse_humanization') {
                if (value) {
                    (0, index_2.initSession)('_default');
                    if (mgr.extensionServer) {
                        mgr.extensionServer.sendCmd('setHumanizationConfig', { enabled: true }).catch(() => { });
                    }
                }
                else {
                    (0, index_2.destroySession)('_default');
                    if (mgr.extensionServer) {
                        mgr.extensionServer.sendCmd('setHumanizationConfig', { enabled: false }).catch(() => { });
                    }
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
// ─── Profile Management ──────────────────────────────────────
/** Create a new managed Chromium profile. */
async function onProfileCreate(mgr, args = {}, options = {}) {
    if (!mgr.extensionServer) {
        const msg = 'Not connected. Call connect first.';
        return options.rawResult
            ? { success: false, error: 'not_connected', message: msg }
            : { content: [{ type: 'text', text: msg }], isError: true };
    }
    try {
        const result = await mgr.extensionServer.sendCmd('profiles.create', {
            name: args.name,
            experiments: args.experiments,
        }, 10000);
        if (options.rawResult)
            return result;
        return {
            content: [{
                    type: 'text',
                    text: mgr.statusHeader() +
                        `### Profile Created\n\n` +
                        `**Name:** ${result.profile?.name}\n` +
                        `**Created:** ${result.profile?.created}\n\n` +
                        `Use \`connect client_id='...' profile='${result.profile?.name}'\` to connect.`,
                }],
        };
    }
    catch (error) {
        if (options.rawResult)
            return { success: false, error: 'create_failed', message: error.message };
        return { content: [{ type: 'text', text: `### Profile Creation Failed\n\n${error.message}` }], isError: true };
    }
}
/** List all managed Chromium profiles. */
async function onProfileList(mgr, options = {}) {
    if (!mgr.extensionServer) {
        const msg = 'Not connected. Call connect first.';
        return options.rawResult
            ? { success: false, error: 'not_connected', message: msg }
            : { content: [{ type: 'text', text: msg }], isError: true };
    }
    try {
        const result = await mgr.extensionServer.sendCmd('profiles.list', {}, 10000);
        if (options.rawResult)
            return result;
        const profiles = result.profiles || [];
        if (profiles.length === 0) {
            return {
                content: [{
                        type: 'text',
                        text: mgr.statusHeader() + '### No Profiles\n\nUse `profile_create` to create one.',
                    }],
            };
        }
        const lines = profiles.map((p) => `- **${p.name}** — created ${p.created}${p.running ? ' (running)' : ''}`);
        return {
            content: [{
                    type: 'text',
                    text: mgr.statusHeader() + `### Profiles (${profiles.length})\n\n${lines.join('\n')}`,
                }],
        };
    }
    catch (error) {
        if (options.rawResult)
            return { success: false, error: 'list_failed', message: error.message };
        return { content: [{ type: 'text', text: `### Profile List Failed\n\n${error.message}` }], isError: true };
    }
}
/** Delete a managed Chromium profile. */
async function onProfileDelete(mgr, args = {}, options = {}) {
    if (!mgr.extensionServer) {
        const msg = 'Not connected. Call connect first.';
        return options.rawResult
            ? { success: false, error: 'not_connected', message: msg }
            : { content: [{ type: 'text', text: msg }], isError: true };
    }
    try {
        const result = await mgr.extensionServer.sendCmd('profiles.delete', {
            name: args.name,
        }, 10000);
        if (options.rawResult)
            return result;
        return {
            content: [{
                    type: 'text',
                    text: mgr.statusHeader() + `### Profile Deleted\n\nProfile "${args.name}" has been removed.`,
                }],
        };
    }
    catch (error) {
        if (options.rawResult)
            return { success: false, error: 'delete_failed', message: error.message };
        return { content: [{ type: 'text', text: `### Profile Deletion Failed\n\n${error.message}` }], isError: true };
    }
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
        content: [{ type: 'text', text: 'Reloading MCP server...' }],
    };
}
//# sourceMappingURL=handlers.js.map