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
exports.applyTabInfoUpdate = applyTabInfoUpdate;
exports.rehydrateAttachedTab = rehydrateAttachedTab;
exports.onDisconnect = onDisconnect;
exports.onStatus = onStatus;
exports.onProfileCreate = onProfileCreate;
exports.onProfileList = onProfileList;
exports.onProfileDelete = onProfileDelete;
exports.onReloadMCP = onReloadMCP;
const shared_1 = require("../shared");
const daemon_spawn_1 = require("../daemon-spawn");
const shared_2 = require("../shared");
const index_1 = require("../experimental/index");
const index_2 = require("../experimental/mouse-humanization/index");
const tips_1 = require("../tips");
const shared_3 = require("../shared");
const log = (0, shared_2.createLog)('[Conn]');
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
    const reg = (0, shared_2.getRegistry)();
    if (reg.debugMode) {
        const sessionLogger = reg.setSessionLog(mgr.clientId);
        log('Session log:', sessionLogger.logFilePath);
    }
    // Fresh attempt — clear any stale failure reason from a prior connect.
    mgr.lastConnectError = null;
    mgr.profile = null;
    try {
        const port = mgr.config.port || 5555;
        // Spawn daemon if not running
        log('Ensuring daemon is running...');
        await (0, daemon_spawn_1.ensureDaemon)(port, mgr.debugMode, mgr.config.enabledExperiments || []);
        // Connect to daemon via Unix socket
        const sockPath = (0, daemon_spawn_1.getSockPath)();
        let client = new shared_1.DaemonClient(sockPath, mgr.clientId);
        await client.start();
        // Refuse to attach to a daemon of a different generation. ensureDaemon
        // only checks PID liveness, so a stale daemon from a previous package
        // version survives upgrades — restart it once with the bundled daemon
        // (owner decision 2026-08-25: daemon lifecycle is server-owned infra,
        // so the restart lives in core, not smart mode).
        let daemonVersion = client.version;
        const serverVersion = mgr.config.server.version;
        if (daemonVersion !== serverVersion) {
            log(`Daemon version mismatch (daemon: ${daemonVersion ?? 'pre-3.0'}, server: ${serverVersion}) — restarting daemon`);
            await client.stop().catch(() => { });
            await (0, daemon_spawn_1.stopDaemon)();
            await (0, daemon_spawn_1.ensureDaemon)(port, mgr.debugMode, mgr.config.enabledExperiments || []);
            client = new shared_1.DaemonClient(sockPath, mgr.clientId);
            await client.start();
            daemonVersion = client.version;
        }
        if (daemonVersion !== serverVersion) {
            await client.stop().catch(() => { });
            mgr.state = 'passive';
            const hint = `A different daemon version is still running after an automatic restart ` +
                `(daemon: ${daemonVersion ?? 'pre-3.0'}, server: ${serverVersion}). ` +
                'Something outside this server keeps respawning it. Restart it manually: ' +
                '`npx supersurf-daemon@latest restart`';
            if (options.rawResult) {
                return { success: false, error: 'version_mismatch', message: hint };
            }
            return {
                content: [{ type: 'text', text: `### Daemon Version Mismatch\n\n${hint}` }],
                isError: true,
            };
        }
        // A version-rejected extension. Without this the session proceeds, the
        // matchmaker refuses every slot, and the agent discovers the problem as a
        // 50s profiles.connect timeout with no cause attached.
        //
        // Two guards keep this scoped. `session_ack` is emitted before any profile
        // binding exists, so its `extensionVersionError` can only describe the
        // UNMANAGED slot — refusing a `connect profile='work'` because the user's
        // everyday Chrome is out of date would blame a browser this session never
        // touches. A managed connect is already covered: `profiles.connect` below
        // fast-fails with the message scoped to that profile. And `extensionConnected`
        // reports the unmanaged slot too, so a stale second extension that poisoned
        // the slot must not refuse a session a healthy one is still serving.
        const extensionVersionError = client.extensionVersionError;
        if (extensionVersionError && !args.profile && !client.extensionConnected) {
            await client.stop().catch(() => { });
            mgr.state = 'passive';
            if (options.rawResult) {
                return {
                    success: false,
                    error: 'extension_version_mismatch',
                    message: extensionVersionError,
                };
            }
            return {
                content: [
                    { type: 'text', text: `### Extension Version Mismatch\n\n${extensionVersionError}` },
                ],
                isError: true,
            };
        }
        mgr.extensionServer = client;
        // Handle extension reconnections — re-query the attached tab so its URL is
        // restored immediately, rather than waiting for the next navigation event.
        // Note: `client` here is always a DaemonClient, and DaemonClient never
        // invokes `onReconnect` (only the legacy bridge.ts ExtensionServer does,
        // on a raw WS reconnect) — so this hook does not currently fire in the
        // live daemon transport. `extensionConnected` intentionally stays
        // whatever it was last set to (seeded false/true at connect, then
        // event-driven by bridge call outcomes) until wired to a real daemon
        // reconnect signal.
        mgr.extensionServer.onReconnect = () => {
            log('Extension reconnected, rehydrating tab state...');
            void rehydrateAttachedTab(mgr, mgr.extensionServer);
        };
        // Monitor tab info updates
        mgr.extensionServer.onTabInfoUpdate = (tabInfo) => {
            log('Tab info update:', tabInfo);
            applyTabInfoUpdate(mgr, tabInfo);
        };
        // Bind experiment registry to daemon transport, keyed by this session's id
        index_1.experimentRegistry.bind(mgr.clientId, client);
        const BB = await getBrowserBridge();
        mgr.bridge = new BB(mgr.config, mgr.extensionServer);
        await mgr.bridge.initialize(mgr.server, mgr.clientInfo, mgr, mgr.metricsLogger);
        mgr.state = 'active';
        mgr.connectedBrowserName = client.browser;
        mgr.extensionConnected = client.extensionConnected;
        // Connect to a managed profile if requested
        if (args.profile && typeof args.profile === 'string') {
            log('Connecting to profile:', args.profile);
            await client.sendCmd('profiles.connect', { profile: args.profile }, 50000);
            mgr.profile = args.profile;
            // profiles.connect resolves only when the matchmaker has a live
            // extension connection for this profile slot.
            mgr.extensionConnected = true;
        }
        // Pre-enable session features from resolved config (fire-and-forget IPC to daemon)
        if (mgr.config.configService) {
            (0, index_1.applyInitialState)(mgr.clientId, mgr.config.configService.get().experiments);
        }
        // Mouse humanization keeps per-session cursor + personality state. Create
        // the session here or generateMovement() has nothing to look up and every
        // humanized move silently degrades to a teleport.
        if (index_1.experimentRegistry.isEnabled('mouse_humanization', mgr.clientId)) {
            (0, index_2.initSession)(mgr.clientId);
        }
        // Notify MCP client that tool list changed
        mgr.notifyToolsListChanged().catch((err) => log('Error sending notification:', err));
        // Notify client about experiment configuration path
        mgr.sendLogNotification('info', 'SuperSurf experiments are toggled via ~/.supersurf/config.json (auto-scaffolded on first daemon start). Restart the daemon after edits.', 'experiments').catch(() => { });
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
                        (mgr.config.showUpgradeNotice ? `${shared_3.UPGRADE_NOTICE_MESSAGE}\n\n` : '') +
                        `### Connected to Service\n\n` +
                        `**State:** ${mgr.extensionConnected ? 'Active' : 'Active — no extension connected'}\n` +
                        `**Browser:** ${mgr.connectedBrowserName}\n\n` +
                        (mgr.extensionConnected
                            ? ''
                            : `⚠️ **No extension connected** — browser tools will fail. Open the SuperSurf popup and click "Enable", or reconnect with \`profile:'<name>'\` to spawn a managed browser.\n\n`) +
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
        mgr.profile = null;
        mgr.extensionConnected = false;
        // Remember why, so a follow-up `status` call surfaces the real cause
        // (e.g. wedged-port EADDRINUSE) instead of a bare cached "Disabled".
        mgr.lastConnectError = error.message;
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
// ─── Tab state ───────────────────────────────────────────────
/**
 * Apply a `tab_info_update` notification to the attached-tab snapshot.
 *
 * A null update clears the tab. A non-null update rebuilds the snapshot **even when
 * `attachedTab` was previously null** — the prior version skipped the update unless a
 * tab was already attached, which left the URL stale/empty after a reconnect (reconnect
 * nulls the tab) and mis-filed fingerprint captures into the 'unknown' bucket. Exported
 * for testing.
 */
function applyTabInfoUpdate(mgr, tabInfo) {
    if (tabInfo === null) {
        mgr.attachedTab = null;
        return;
    }
    mgr.attachedTab = {
        ...(mgr.attachedTab || {}),
        id: tabInfo.id,
        title: tabInfo.title,
        url: tabInfo.url,
        index: tabInfo.index,
        techStack: tabInfo.techStack || null,
    };
}
/**
 * After a reconnect, re-query the extension for the attached tab and repopulate
 * `mgr.attachedTab` (URL included). Without this, the tab stays null until the next
 * navigation fires a `tab_info_update`, so any fingerprint capture in between has no
 * live URL and gets dropped. Best-effort: any failure falls back to null. Exported for testing.
 */
async function rehydrateAttachedTab(mgr, client) {
    try {
        const res = await client.sendCmd('getTabs', {}, 10000);
        const tabs = res?.tabs || [];
        const attached = tabs.find((t) => t.attached);
        mgr.attachedTab = attached
            ? {
                id: attached.id,
                index: attached.index,
                title: attached.title,
                url: attached.url,
                techStack: attached.techStack || null,
            }
            : null;
    }
    catch {
        mgr.attachedTab = null;
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
    // Close session log, clear tip suppression counters, drop session-scoped
    // experiment + cursor state. All keyed by client_id so a second
    // ConnectionManager in this process keeps its own.
    if (mgr.clientId) {
        (0, shared_2.getRegistry)().clearSessionLog(mgr.clientId);
        (0, tips_1.clearTipCounters)(mgr.clientId);
        index_1.experimentRegistry.unbind(mgr.clientId);
        (0, index_2.destroySession)(mgr.clientId);
    }
    mgr.state = 'passive';
    mgr.connectedBrowserName = null;
    mgr.attachedTab = null;
    mgr.profile = null;
    mgr.extensionConnected = false;
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
/**
 * Execute a callback with a daemon connection. Reuses the existing extensionServer
 * if connected, otherwise spawns the daemon (if needed) and creates a temporary
 * DaemonClient for the duration of the call. This lets profile tools work from
 * passive state without a full connect/disconnect cycle.
 */
async function withDaemonConnection(mgr, fn) {
    // Reuse existing connection if available
    if (mgr.extensionServer) {
        return fn({
            sendCmd: (method, params, timeout) => mgr.extensionServer.sendCmd(method, params, timeout),
        });
    }
    // Create a temporary daemon connection
    await (0, daemon_spawn_1.ensureDaemon)(mgr.config.port || 5555, mgr.debugMode, mgr.config.enabledExperiments || []);
    const sockPath = (0, daemon_spawn_1.getSockPath)();
    const tempClient = new shared_1.DaemonClient(sockPath, `profile-mgmt-${Date.now()}`);
    try {
        await tempClient.start();
        return await fn({
            sendCmd: (method, params, timeout) => tempClient.sendCmd(method, params, timeout),
        });
    }
    finally {
        await tempClient.stop().catch(() => { });
    }
}
/** Create a new managed Chromium profile. */
async function onProfileCreate(mgr, args = {}, options = {}) {
    try {
        return await withDaemonConnection(mgr, async (client) => {
            const result = await client.sendCmd('profiles.create', {
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
        });
    }
    catch (error) {
        if (options.rawResult)
            return { success: false, error: 'create_failed', message: error.message };
        return { content: [{ type: 'text', text: `### Profile Creation Failed\n\n${error.message}` }], isError: true };
    }
}
/** List all managed Chromium profiles. */
async function onProfileList(mgr, options = {}) {
    try {
        return await withDaemonConnection(mgr, async (client) => {
            const result = await client.sendCmd('profiles.list', {}, 10000);
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
        });
    }
    catch (error) {
        if (options.rawResult)
            return { success: false, error: 'list_failed', message: error.message };
        return { content: [{ type: 'text', text: `### Profile List Failed\n\n${error.message}` }], isError: true };
    }
}
/** Delete a managed Chromium profile. */
async function onProfileDelete(mgr, args = {}, options = {}) {
    try {
        return await withDaemonConnection(mgr, async (client) => {
            const result = await client.sendCmd('profiles.delete', {
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
        });
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