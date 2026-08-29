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
const keep_browser_1 = require("./profiles/keep-browser");
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
    configDrift = false;
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
    /** Mark that the on-disk config has changed since daemon startup. */
    setConfigDrift(drifted) {
        this.configDrift = drifted;
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
                                version: this.meta.version,
                                // Unmanaged-slot extension presence. The session is not yet
                                // profile-bound at ack time; a later profiles.connect success
                                // is itself proof of a live extension for that slot.
                                extensionConnected: this.bridge.matchmaker.getConnectionForProfile(null) !== null,
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
                    // Kill Chromium if no other sessions are using this profile.
                    // User-owned browsers (launched via `supersurf profiles open`) are
                    // never killed by session lifecycle — the human closes them.
                    // Daemon-owned browsers are killed unless keepBrowserOnSessionEnd is true.
                    const remaining = this.sessions.getSessionsForProfile(profileId);
                    if (remaining.length === 0) {
                        const pid = this.profileRegistry.getRunningPid(profileId);
                        const extConn = this.bridge.matchmaker.getConnectionForProfile(profileId);
                        if (pid &&
                            !this.profileRegistry.isUserOwned(profileId) &&
                            !(0, keep_browser_1.shouldKeepBrowserOnSessionEnd)(extConn)) {
                            debugLog(`Last session for profile "${profileId}" disconnected — killing Chromium (pid ${pid})`);
                            try {
                                process.kill(pid, 'SIGTERM');
                                (0, chrome_1.appendPidLog)({ action: 'kill', profile: profileId, pid, ts: new Date().toISOString() });
                            }
                            catch { }
                            this.profileRegistry.clearRunningPid(profileId);
                        }
                        else if (pid && (0, keep_browser_1.shouldKeepBrowserOnSessionEnd)(extConn)) {
                            debugLog(`Last session for profile "${profileId}" disconnected — keeping Chromium (pid ${pid})`);
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
                const matchmaker = this.bridge.matchmaker;
                const profiles = this.profileRegistry.list().map((p) => ({
                    ...p,
                    owner: this.profileRegistry.getOwner(p.name),
                    connected: !!matchmaker?.getConnectionForProfile(p.name),
                }));
                return { profiles };
            }
            case 'profiles.delete': {
                const name = params.name;
                const refuseIfRunning = params.refuseIfRunning;
                this.profileRegistry.delete(name, this.sessions, { refuseIfRunning });
                return { success: true };
            }
            case 'profiles.rename': {
                const name = params.name;
                const newName = params.newName;
                const config = this.profileRegistry.rename(name, newName, this.sessions);
                return { success: true, profile: config };
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
                // Spawn Chromium only if it isn't running AND no live extension
                // connection exists for this profile. A CLI-launched (user-owned)
                // browser is unknown to registry.runningPids but present in the
                // matchmaker pool — without the pool check we'd double-spawn onto
                // the same --user-data-dir. Pool check first: it's side-effect-free,
                // whereas registry.isRunning() self-heals (clears the pid) on a dead
                // process, which would erase ownership tracking for a still-pooled
                // (but registry-untracked) user-launched browser.
                const didSpawn = !matchmaker.getConnectionForProfile(profile) && !registry.isRunning(profile);
                if (didSpawn) {
                    await this.spawnProfile(profile, 'daemon');
                }
                // Wait for matching extension connection. When this request performed
                // the spawn, watch the Chromium PID and fail within ~1s of its death
                // instead of burning the full match window.
                debugLog(`Waiting for extension match for profile "${profile}"...`);
                const conn = await this.awaitMatchWithDeathWatch(profile, didSpawn, 45000);
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
            case 'profiles.launch': {
                const profile = params.profile;
                if (!profile)
                    throw new Error('Profile name is required');
                if (!this.profileRegistry.exists(profile)) {
                    throw new Error(`Profile '${profile}' not found. Use profile_create first.`);
                }
                const matchmaker = this.bridge.matchmaker;
                const registry = this.profileRegistry;
                // Already running (daemon- or user-owned) or already connected? Report, don't spawn.
                // Pool check first — isRunning() self-heals (clears stale pid+owner) which
                // would mask a live connection if checked second.
                if (matchmaker.getConnectionForProfile(profile) || registry.isRunning(profile)) {
                    return { success: true, alreadyRunning: true, owner: registry.getOwner(profile) };
                }
                await this.spawnProfile(profile, 'user');
                // Wait for the extension in the fresh Chromium to announce itself.
                debugLog(`Waiting for extension match for profile "${profile}" (user launch)...`);
                await this.awaitMatchWithDeathWatch(profile, true, 45000);
                if (!registry.isInitialized(profile)) {
                    registry.markInitialized(profile);
                }
                return { success: true, alreadyRunning: false, owner: registry.getOwner(profile) ?? 'user' };
            }
            default:
                throw new Error(`Unknown profile method: ${method}`);
        }
    }
    /**
     * Race the matchmaker wait against a liveness watch on the just-spawned
     * Chromium. Only watches when this request performed the spawn — a
     * user-launched browser is not registry-tracked, so watchPid=false skips
     * the watch entirely. The registry self-heals (spawnProfile's exit handler
     * clears the PID), so isRunning() flipping false means the process died.
     * Accepted scope gap: the watch only arms for Chromium this request spawned
     * (watchPid/didSpawn) — an already-running profile that dies mid-match
     * falls back to the full 45s timeout by design.
     */
    awaitMatchWithDeathWatch(profile, watchPid, timeoutMs) {
        const match = this.bridge.matchmaker.requestMatch(profile, timeoutMs);
        if (!watchPid)
            return match;
        let watcher;
        const death = new Promise((_, reject) => {
            watcher = setInterval(() => {
                if (!this.profileRegistry.isRunning(profile)) {
                    reject(new Error(`Chromium for profile '${profile}' exited before the extension connected. ` +
                        `Check ~/.supersurf/logs/daemon.log; if the GPU driver is the cause, set ` +
                        '`profiles.startup_opts.disable_gpu: true` in ~/.supersurf/config.json.'));
                }
            }, 1000);
        });
        return Promise.race([match, death]).finally(() => {
            if (watcher)
                clearInterval(watcher);
            // A lost race leaves the pending match queued; its own timeout clears it.
        });
    }
    /**
     * Spawn Chromium for a profile through the bootstrap queue.
     * owner='daemon': killed when the last session for the profile disconnects.
     * owner='user': survives sessions, daemon shutdown, and the orphan sweep.
     */
    async spawnProfile(profile, owner) {
        const matchmaker = this.bridge.matchmaker;
        const registry = this.profileRegistry;
        await matchmaker.enqueueBootstrap(async () => {
            if (registry.isRunning(profile))
                return; // double-check after queue
            matchmaker.pendingSpawns.add(profile);
            try {
                // Always open the registration URL so the extension re-binds its
                // profile in chrome.storage.local on every spawn. An already-
                // initialized profile whose storage lost `supersurf_profile`
                // (force-kill, rsync'd profile, Chrome corruption) would otherwise
                // hand the daemon a handshake with no profile field, get pooled as
                // unmanaged, and never resolve the pending match.
                const child = (0, chrome_1.spawnChromium)(profile, (0, extension_source_1.getExtensionDir)(), this.meta.port, true, this.meta.startupOpts ?? {});
                const pid = child.pid;
                registry.setRunningPid(profile, pid, owner);
                (0, chrome_1.appendPidLog)({ action: 'spawn', profile, pid, owner, ts: new Date().toISOString() });
                // Listen for crash/close
                child.on('exit', (code) => {
                    debugLog(`Chromium exited for profile "${profile}" (code=${code})`);
                    registry.clearRunningPid(profile);
                    (0, chrome_1.appendPidLog)({ action: 'kill', profile, pid, ts: new Date().toISOString() });
                    // A user-owned browser closing may unblock the idle timeout —
                    // re-evaluate via the session-count callback.
                    if (this.onSessionCountChange) {
                        this.onSessionCountChange(this.sessions.count);
                    }
                });
            }
            finally {
                matchmaker.pendingSpawns.delete(profile);
            }
        });
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
    /** Write an NDJSON line to a socket. Injects `config_drift` into session_ack
     *  and JSON-RPC response envelopes when the config file has changed since
     *  daemon startup. */
    sendLine(socket, data) {
        if (!socket.writable)
            return;
        if (this.configDrift && data && typeof data === 'object'
            && (data.type === 'session_ack' || data.jsonrpc === '2.0')) {
            data = { ...data, config_drift: true };
        }
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