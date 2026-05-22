"use strict";
/**
 * IPC Server — Unix socket server for MCP session connections.
 *
 * Accepts connections from MCP servers over a Unix domain socket.
 * Protocol:
 *   1. MCP server sends: { type: "session_register", sessionId: "..." }\n
 *   2. Daemon responds: { type: "session_ack", browser: "...", buildTimestamp: "..." }\n
 *      or { type: "session_reject", reason: "..." }\n
 *   3. Post-handshake: NDJSON (newline-delimited JSON-RPC 2.0) for tool calls
 *
 * @module ipc
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IPCServer = void 0;
const net_1 = __importDefault(require("net"));
const types_1 = require("./experiments/types");
const types_2 = require("./profiles/types");
const chrome_1 = require("./profiles/chrome");
const extension_source_1 = require("./profiles/extension-source");
const debugLog = (...args) => {
    const logger = global.DAEMON_LOGGER;
    if (logger)
        logger.log('[IPC]', ...args);
    else if (global.DAEMON_DEBUG)
        console.error('[IPC]', ...args);
};
/**
 * Unix domain socket server for MCP session connections.
 * Handles session handshake, NDJSON message routing, and cleanup.
 */
class IPCServer {
    server = null;
    socketPath;
    bridge;
    sessions;
    scheduler;
    experiments;
    profileRegistry;
    onSessionCountChange = null;
    startedAt = Date.now();
    meta;
    constructor(socketPath, bridge, sessions, scheduler, experiments, profileRegistry, meta = { port: 5555, version: 'unknown' }) {
        this.socketPath = socketPath;
        this.bridge = bridge;
        this.sessions = sessions;
        this.scheduler = scheduler;
        this.experiments = experiments;
        this.meta = meta;
        this.profileRegistry = profileRegistry;
    }
    /** Set a callback for session count changes (used by idle timeout). */
    setSessionCountCallback(cb) {
        this.onSessionCountChange = cb;
    }
    /** Start listening on the Unix socket. */
    async start() {
        return new Promise((resolve, reject) => {
            this.server = net_1.default.createServer((socket) => this.handleConnection(socket));
            this.server.on('error', (error) => {
                debugLog('IPC server error:', error);
                reject(error);
            });
            this.server.listen(this.socketPath, () => {
                debugLog(`IPC listening on ${this.socketPath}`);
                resolve();
            });
        });
    }
    /** Handle a new connection from an MCP server. */
    handleConnection(socket) {
        debugLog('New IPC connection');
        let buffer = '';
        let sessionId = null;
        let handshakeComplete = false;
        socket.on('data', (data) => {
            buffer += data.toString();
            let newlineIdx;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);
                if (!line)
                    continue;
                try {
                    const msg = JSON.parse(line);
                    if (!handshakeComplete) {
                        // Pre-auth status query — no handshake needed
                        if (msg.type === 'daemon_status') {
                            this.sendLine(socket, this.buildStatusResponse());
                            socket.end();
                            return;
                        }
                        // Expecting session_register handshake
                        if (msg.type === 'session_register' && msg.sessionId) {
                            sessionId = msg.sessionId;
                            if (this.sessions.has(sessionId)) {
                                this.sendLine(socket, {
                                    type: 'session_reject',
                                    reason: 'Session ID already in use',
                                });
                                socket.end();
                                return;
                            }
                            // Register the session
                            this.sessions.add(sessionId, socket);
                            this.scheduler.addSession(sessionId);
                            this.sendLine(socket, {
                                type: 'session_ack',
                                browser: this.bridge.browser,
                                buildTimestamp: this.bridge.buildTime,
                            });
                            handshakeComplete = true;
                            debugLog(`Session registered: "${sessionId}"`);
                            if (this.onSessionCountChange) {
                                this.onSessionCountChange(this.sessions.count);
                            }
                        }
                        else {
                            this.sendLine(socket, {
                                type: 'session_reject',
                                reason: 'Expected session_register handshake',
                            });
                            socket.end();
                        }
                    }
                    else {
                        // Post-handshake: JSON-RPC 2.0 requests
                        this.handleRequest(sessionId, socket, msg);
                    }
                }
                catch (err) {
                    debugLog('Parse error:', err.message);
                    if (handshakeComplete && sessionId) {
                        this.sendLine(socket, {
                            jsonrpc: '2.0',
                            id: null,
                            error: { code: -32700, message: `Parse error: ${err.message}` },
                        });
                    }
                }
            }
        });
        socket.on('close', () => {
            if (sessionId) {
                debugLog(`Session disconnected: "${sessionId}"`);
                // Unbind profile if set
                const profileId = this.sessions.getProfileId(sessionId);
                if (profileId) {
                    this.sessions.setProfileId(sessionId, null);
                }
                this.scheduler.removeSession(sessionId);
                this.sessions.remove(sessionId);
                this.experiments.deleteSession(sessionId);
                // Notify extension to ungroup the session's tabs
                if (profileId) {
                    this.bridge.sendCmdToProfile(profileId, 'sessionDisconnect', { sessionId }, 5000).catch(() => { });
                    // Kill Chromium if no other sessions are using this profile
                    const remaining = this.sessions.getSessionsForProfile(profileId);
                    if (remaining.length === 0) {
                        const pid = this.profileRegistry.getRunningPid(profileId);
                        if (pid) {
                            debugLog(`Last session for profile "${profileId}" disconnected — killing Chromium (pid ${pid})`);
                            try {
                                process.kill(pid, 'SIGTERM');
                                (0, chrome_1.appendPidLog)({ action: 'kill', profile: profileId, pid, ts: new Date().toISOString() });
                            }
                            catch { }
                            this.profileRegistry.clearRunningPid(profileId);
                        }
                    }
                }
                else {
                    this.bridge.sendCmd('sessionDisconnect', { sessionId }, 5000).catch(() => { });
                }
                if (this.onSessionCountChange) {
                    this.onSessionCountChange(this.sessions.count);
                }
            }
        });
        socket.on('error', (error) => {
            debugLog('Socket error:', error.message);
        });
    }
    /** Route a JSON-RPC 2.0 request — experiment methods are handled directly, everything else goes to the scheduler. */
    async handleRequest(sessionId, socket, msg) {
        if (msg.jsonrpc !== '2.0' || !msg.method || msg.id === undefined) {
            this.sendLine(socket, {
                jsonrpc: '2.0',
                id: msg.id ?? null,
                error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
            });
            return;
        }
        // Profile IPC — handle directly, skip scheduler
        if ((0, types_2.isProfileMethod)(msg.method)) {
            try {
                const result = await this.handleProfileRequest(sessionId, msg.method, msg.params || {});
                this.sendLine(socket, { jsonrpc: '2.0', id: msg.id, result });
            }
            catch (error) {
                this.sendLine(socket, {
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32000, message: error.message || String(error) },
                });
            }
            return;
        }
        // Experiment IPC — handle directly, skip scheduler
        if ((0, types_1.isExperimentMethod)(msg.method)) {
            try {
                const result = this.handleExperimentRequest(sessionId, msg.method, msg.params || {});
                this.sendLine(socket, { jsonrpc: '2.0', id: msg.id, result });
            }
            catch (error) {
                this.sendLine(socket, {
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32000, message: error.message || String(error) },
                });
            }
            return;
        }
        try {
            const result = await this.scheduler.enqueue(sessionId, msg.method, msg.params || {}, msg.timeout || 30000);
            this.sendLine(socket, { jsonrpc: '2.0', id: msg.id, result });
        }
        catch (error) {
            this.sendLine(socket, {
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32000, message: error.message || String(error) },
            });
        }
    }
    /** Handle an experiment IPC request directly (no scheduler round-trip). */
    handleExperimentRequest(sessionId, method, params) {
        switch (method) {
            case 'experiments.toggle':
                return {
                    success: true,
                    experiment: params.experiment,
                    enabled: this.experiments.toggle(sessionId, params.experiment, params.enabled),
                };
            case 'experiments.get':
                return { experiments: this.experiments.getAll(sessionId) };
            case 'experiments.getOne':
                return {
                    experiment: params.experiment,
                    enabled: this.experiments.isEnabled(sessionId, params.experiment),
                };
            default:
                throw new Error(`Unknown experiment method: ${method}`);
        }
    }
    /** Handle a profile IPC request directly (no scheduler round-trip). */
    async handleProfileRequest(sessionId, method, params) {
        switch (method) {
            case 'profiles.create': {
                const name = params.name;
                const experiments = params.experiments;
                const config = this.profileRegistry.create(name, experiments);
                return { success: true, profile: config };
            }
            case 'profiles.list': {
                const profiles = this.profileRegistry.list();
                return { profiles };
            }
            case 'profiles.delete': {
                const name = params.name;
                this.profileRegistry.delete(name, this.sessions);
                return { success: true };
            }
            case 'profiles.connect': {
                const profile = params.profile;
                if (!profile)
                    throw new Error('Profile name is required');
                if (!this.profileRegistry.exists(profile)) {
                    throw new Error(`Profile '${profile}' not found. Use profile_create first.`);
                }
                const matchmaker = this.bridge.matchmaker;
                const registry = this.profileRegistry;
                // Spawn Chromium if not running
                if (!registry.isRunning(profile)) {
                    await matchmaker.enqueueBootstrap(async () => {
                        if (registry.isRunning(profile))
                            return; // double-check after queue
                        matchmaker.pendingSpawns.add(profile);
                        try {
                            const isFirstLaunch = !registry.isInitialized(profile);
                            const child = (0, chrome_1.spawnChromium)(profile, (0, extension_source_1.getExtensionDir)(), this.meta.port, isFirstLaunch);
                            const pid = child.pid;
                            registry.setRunningPid(profile, pid);
                            (0, chrome_1.appendPidLog)({ action: 'spawn', profile, pid, ts: new Date().toISOString() });
                            // Listen for crash
                            child.on('exit', (code) => {
                                debugLog(`Chromium exited for profile "${profile}" (code=${code})`);
                                registry.clearRunningPid(profile);
                                (0, chrome_1.appendPidLog)({ action: 'kill', profile, pid, ts: new Date().toISOString() });
                            });
                        }
                        finally {
                            matchmaker.pendingSpawns.delete(profile);
                        }
                    });
                }
                // Wait for matching extension connection
                debugLog(`Waiting for extension match for profile "${profile}"...`);
                const conn = await matchmaker.requestMatch(profile, 90000);
                // Mark initialized if first launch succeeded
                if (!registry.isInitialized(profile)) {
                    registry.markInitialized(profile);
                }
                // Bind session to profile
                this.sessions.setProfileId(sessionId, profile);
                // Apply experiment defaults from profile config
                const config = registry.get(profile);
                if (config?.experiments) {
                    const expNames = Object.entries(config.experiments)
                        .filter(([, v]) => v)
                        .map(([k]) => k);
                    if (expNames.length > 0) {
                        for (const name of expNames) {
                            this.experiments.toggle(sessionId, name, true);
                        }
                    }
                }
                return {
                    success: true,
                    profile,
                    browser: conn.browser,
                    buildTimestamp: conn.buildTimestamp,
                };
            }
            default:
                throw new Error(`Unknown profile method: ${method}`);
        }
    }
    /** Build a status response from live daemon state. */
    buildStatusResponse() {
        const sessions = [];
        for (const session of this.sessions.values()) {
            sessions.push({
                sessionId: session.sessionId,
                attachedTabId: session.attachedTabId,
                ownedTabCount: session.ownedTabs.size,
                profileId: session.profileId,
            });
        }
        return {
            type: 'daemon_status',
            version: this.meta.version,
            uptimeSeconds: (Date.now() - this.startedAt) / 1000,
            port: this.meta.port,
            extensionConnected: this.bridge.connected,
            extensionBrowser: this.bridge.browser,
            sessions,
            schedulerQueueDepth: this.scheduler.getQueueDepth(),
        };
    }
    /** Write an NDJSON line to a socket. */
    sendLine(socket, data) {
        if (!socket.writable)
            return;
        socket.write(JSON.stringify(data) + '\n');
    }
    /** Gracefully shut down the IPC server. */
    async stop() {
        return new Promise((resolve) => {
            if (!this.server) {
                resolve();
                return;
            }
            // Close all session sockets
            for (const session of this.sessions.values()) {
                session.socket.end();
            }
            this.server.close(() => {
                debugLog('IPC server stopped');
                resolve();
            });
        });
    }
}
exports.IPCServer = IPCServer;
//# sourceMappingURL=ipc.js.map