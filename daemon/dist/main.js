#!/usr/bin/env node
"use strict";
/**
 * SuperSurf Daemon — standalone coordinator for multiple MCP sessions.
 *
 * Manages a single Chrome extension connection (WebSocket) and multiplexes
 * tool calls from multiple MCP servers (Unix domain socket).
 *
 * Usage:
 *   supersurf-daemon [start] [--port <n>] [--debug]
 *   supersurf-daemon stop
 *   supersurf-daemon restart [--port <n>] [--debug]
 *   supersurf-daemon status
 *
 * Files:
 *   ~/.supersurf/daemon.pid   — PID file for process detection
 *   ~/.supersurf/daemon.sock  — Unix domain socket for MCP server IPC
 *   ~/.supersurf/logs/daemon.log — debug log (when --debug)
 *
 * @module main
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IDLE_TIMEOUT_MS = exports.SOCK_FILE = exports.PID_FILE = exports.SUPERSURF_DIR = void 0;
exports.parseArgs = parseArgs;
exports.isProcessAlive = isProcessAlive;
exports.cleanStaleFiles = cleanStaleFiles;
exports.stopDaemon = stopDaemon;
exports.printStatus = printStatus;
exports.observe = observe;
exports.formatUptime = formatUptime;
exports.getVersion = getVersion;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const net_1 = __importDefault(require("net"));
const child_process_1 = require("child_process");
const shared_1 = require("./shared");
const extension_bridge_1 = require("./extension-bridge");
const session_1 = require("./session");
const scheduler_1 = require("./scheduler");
const ipc_1 = require("./ipc");
const index_1 = require("./experiments/index");
const registry_1 = require("./profiles/registry");
const extension_source_1 = require("./profiles/extension-source");
const chrome_1 = require("./profiles/chrome");
const SUPERSURF_DIR = path_1.default.join(os_1.default.homedir(), '.supersurf');
exports.SUPERSURF_DIR = SUPERSURF_DIR;
const PID_FILE = path_1.default.join(SUPERSURF_DIR, 'daemon.pid');
exports.PID_FILE = PID_FILE;
const SOCK_FILE = path_1.default.join(SUPERSURF_DIR, 'daemon.sock');
exports.SOCK_FILE = SOCK_FILE;
const LOG_FILE = path_1.default.join(SUPERSURF_DIR, 'logs', 'daemon.log');
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
exports.IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MS;
// ─── CLI Parsing ──────────────────────────────────────────────
function parseArgs(argv) {
    let port = 5555;
    let debug = false;
    let verbose = false;
    let command;
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--port' && argv[i + 1]) {
            port = parseInt(argv[i + 1], 10);
            if (isNaN(port)) {
                console.error('Invalid port number');
                process.exit(1);
            }
            i++;
        }
        else if (argv[i] === '--debug') {
            debug = true;
        }
        else if (argv[i] === '--verbose') {
            verbose = true;
        }
        else if (argv[i] === 'start') {
            command = 'start';
        }
        else if (argv[i] === 'stop') {
            command = 'stop';
        }
        else if (argv[i] === 'restart') {
            command = 'restart';
        }
        else if (argv[i] === 'status') {
            command = 'status';
        }
        else if (argv[i] === 'observe') {
            command = 'observe';
        }
    }
    return { port, debug, verbose, command };
}
// ─── Status Command ──────────────────────────────────────────
/** Query the daemon over the Unix socket for live state. */
function queryDaemonStatus(verbose) {
    return new Promise((resolve, reject) => {
        if (!fs_1.default.existsSync(SOCK_FILE)) {
            reject(new Error('Socket not found'));
            return;
        }
        const socket = net_1.default.createConnection(SOCK_FILE);
        let buffer = '';
        const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error('Query timeout'));
        }, 3000);
        socket.on('connect', () => {
            socket.write(JSON.stringify({ type: 'daemon_status', verbose }) + '\n');
        });
        socket.on('data', (data) => {
            buffer += data.toString();
            const idx = buffer.indexOf('\n');
            if (idx !== -1) {
                clearTimeout(timeout);
                try {
                    resolve(JSON.parse(buffer.slice(0, idx)));
                }
                catch {
                    reject(new Error('Invalid response'));
                }
                socket.end();
            }
        });
        socket.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}
/** Format uptime seconds into human-readable string. */
function formatUptime(seconds) {
    if (seconds < 60)
        return `${Math.floor(seconds)}s`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
}
/** Read package version from package.json */
function getVersion() {
    try {
        const pkg = JSON.parse(fs_1.default.readFileSync(path_1.default.join(__dirname, '..', 'package.json'), 'utf8'));
        return pkg.version || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
async function printStatus(verbose) {
    const daemonRunning = fs_1.default.existsSync(PID_FILE);
    let pid = null;
    let alive = false;
    if (daemonRunning) {
        try {
            pid = parseInt(fs_1.default.readFileSync(PID_FILE, 'utf8').trim(), 10);
            alive = !isNaN(pid) && isProcessAlive(pid);
        }
        catch { }
    }
    if (!alive) {
        console.log('Daemon not running');
        if (daemonRunning)
            console.log('(stale PID file found — will be cleaned on next start)');
        process.exit(1);
        return;
    }
    // Try live query
    try {
        const status = await queryDaemonStatus(verbose);
        if (verbose) {
            const version = status.version || getVersion();
            console.log(`SuperSurf Daemon v${version}`);
            console.log(`  PID:        ${pid}`);
            console.log(`  Uptime:     ${formatUptime(status.uptimeSeconds)}`);
            console.log(`  Port:       ${status.port}`);
            console.log(`  Socket:     ${SOCK_FILE}`);
            console.log(`  Log:        ${LOG_FILE}`);
            console.log('');
            console.log('Extension');
            console.log(`  Status:     ${status.extensionConnected ? 'connected' : 'disconnected'}`);
            if (status.extensionBrowser) {
                console.log(`  Browser:    ${status.extensionBrowser}`);
            }
            console.log('');
            console.log(`Sessions (${status.sessions.length})`);
            if (status.sessions.length === 0) {
                console.log('  (none)');
            }
            else {
                for (const s of status.sessions) {
                    const tab = s.attachedTabId ? `tab #${s.attachedTabId}` : 'no tab';
                    const owned = `${s.ownedTabCount} owned tab${s.ownedTabCount !== 1 ? 's' : ''}`;
                    console.log(`  ${s.sessionId}   ${tab}   ${owned}`);
                }
            }
            console.log('');
            console.log('Scheduler');
            console.log(`  Queue:      ${status.schedulerQueueDepth} pending`);
        }
        else {
            const version = status.version || getVersion();
            const ext = status.extensionConnected ? 'connected' : 'disconnected';
            console.log(`SuperSurf Daemon v${version} (pid ${pid})`);
            console.log(`  Uptime:      ${formatUptime(status.uptimeSeconds)}`);
            console.log(`  Extension:   ${ext}`);
            console.log(`  Sessions:    ${status.sessions.length} active`);
            console.log('');
            console.log('Run `supersurf-daemon status --verbose` for full details.');
        }
    }
    catch {
        // Fallback: socket query failed, show basic PID info
        console.log(`Daemon running (pid ${pid})`);
        console.log(`Socket: ${fs_1.default.existsSync(SOCK_FILE) ? SOCK_FILE : 'missing'}`);
    }
    process.exit(0);
}
// ─── Observe Command ─────────────────────────────────────────
function observe() {
    if (!fs_1.default.existsSync(LOG_FILE)) {
        console.error(`Log file not found: ${LOG_FILE}`);
        process.exit(1);
    }
    console.log(`Tailing ${LOG_FILE} (Ctrl+C to stop)\n`);
    const tail = (0, child_process_1.spawn)('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
    tail.on('exit', (code) => process.exit(code ?? 0));
    process.on('SIGINT', () => { tail.kill(); process.exit(0); });
}
// ─── Stop Command ───────────────────────────────────────────
/** Stop the running daemon by sending SIGTERM to the PID in the PID file. */
function stopDaemon() {
    if (!fs_1.default.existsSync(PID_FILE)) {
        console.log('Daemon not running (no PID file)');
        return false;
    }
    let pid;
    try {
        pid = parseInt(fs_1.default.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (isNaN(pid)) {
            console.log('Daemon not running (invalid PID file)');
            return false;
        }
    }
    catch {
        console.log('Daemon not running (cannot read PID file)');
        return false;
    }
    if (!isProcessAlive(pid)) {
        console.log(`Daemon not running (stale PID ${pid})`);
        // Clean up stale files
        try {
            fs_1.default.unlinkSync(PID_FILE);
        }
        catch { }
        try {
            fs_1.default.unlinkSync(SOCK_FILE);
        }
        catch { }
        return false;
    }
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch (err) {
        console.error(`Failed to stop daemon (pid ${pid}): ${err.message}`);
        return false;
    }
    // Wait up to 5s for the process to exit
    const start = Date.now();
    while (Date.now() - start < 5000) {
        if (!isProcessAlive(pid)) {
            console.log(`Daemon stopped (pid ${pid})`);
            return true;
        }
        // Busy-wait in small increments (sync — this is a CLI command, not the server)
        const waitUntil = Date.now() + 100;
        while (Date.now() < waitUntil) { /* spin */ }
    }
    // Still alive after 5s — escalate to SIGKILL
    try {
        process.kill(pid, 'SIGKILL');
        console.log(`Daemon killed (pid ${pid}) — did not exit gracefully`);
    }
    catch { }
    // Clean up files the hard way
    try {
        fs_1.default.unlinkSync(PID_FILE);
    }
    catch { }
    try {
        fs_1.default.unlinkSync(SOCK_FILE);
    }
    catch { }
    return true;
}
// ─── PID File Management ──────────────────────────────────────
/** Check if a process with the given PID is alive. */
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/** Clean stale PID/socket files if the referenced process is dead. */
function cleanStaleFiles() {
    if (fs_1.default.existsSync(PID_FILE)) {
        try {
            const pid = parseInt(fs_1.default.readFileSync(PID_FILE, 'utf8').trim(), 10);
            if (!isNaN(pid) && !isProcessAlive(pid)) {
                fs_1.default.unlinkSync(PID_FILE);
                if (fs_1.default.existsSync(SOCK_FILE)) {
                    fs_1.default.unlinkSync(SOCK_FILE);
                }
            }
        }
        catch {
            // If we can't read the PID file, clean both
            try {
                fs_1.default.unlinkSync(PID_FILE);
            }
            catch { }
            try {
                fs_1.default.unlinkSync(SOCK_FILE);
            }
            catch { }
        }
    }
    else if (fs_1.default.existsSync(SOCK_FILE)) {
        // Orphaned socket file without a PID file — clean it
        try {
            fs_1.default.unlinkSync(SOCK_FILE);
        }
        catch { }
    }
}
/** Write current PID to the PID file. */
function writePidFile() {
    fs_1.default.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}
/** Remove PID and socket files on shutdown. */
function cleanupFiles() {
    try {
        fs_1.default.unlinkSync(PID_FILE);
    }
    catch { }
    try {
        fs_1.default.unlinkSync(SOCK_FILE);
    }
    catch { }
}
// ─── Main ──────────────────────────────────────────────────────
async function main() {
    const { port, debug, verbose, command } = parseArgs(process.argv);
    if (command === 'status') {
        await printStatus(verbose);
        return;
    }
    if (command === 'stop') {
        stopDaemon();
        return;
    }
    if (command === 'restart') {
        stopDaemon();
        // Fall through to start the daemon fresh
    }
    if (command === 'observe') {
        observe();
        return;
    }
    // Initialize logger — always enabled for core events
    const logger = new shared_1.FileLogger(LOG_FILE);
    logger.enable();
    global.DAEMON_LOGGER = logger;
    if (debug) {
        global.DAEMON_DEBUG = true;
    }
    logger.log(`[Daemon] Starting daemon (port=${port}, pid=${process.pid})`);
    // Ensure ~/.supersurf/ exists
    if (!fs_1.default.existsSync(SUPERSURF_DIR)) {
        fs_1.default.mkdirSync(SUPERSURF_DIR, { recursive: true });
    }
    // Clean stale files from a crashed previous instance
    cleanStaleFiles();
    // Check if daemon is already running
    if (fs_1.default.existsSync(PID_FILE)) {
        const existingPid = parseInt(fs_1.default.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
            console.error(`Daemon already running (pid ${existingPid})`);
            process.exit(1);
        }
    }
    // Write PID file
    writePidFile();
    // Pre-enable experiments from env var (e.g. SUPERSURF_EXPERIMENTS=page_diffing,smart_waiting)
    const envExperiments = process.env.SUPERSURF_EXPERIMENTS;
    const envExpNames = envExperiments
        ? envExperiments.split(',').map(s => s.trim()).filter(Boolean)
        : [];
    const profilesEnabled = envExpNames.includes('profiles');
    // Initialize components
    const bridge = new extension_bridge_1.ExtensionBridge(port, '127.0.0.1', profilesEnabled);
    const sessions = new session_1.SessionRegistry();
    const scheduler = new scheduler_1.RequestScheduler(bridge, sessions);
    const experiments = new index_1.DaemonExperimentRegistry();
    if (envExpNames.length > 0) {
        experiments.applyDefaults(envExpNames);
        logger.log(`[Daemon] Experiment defaults: ${envExpNames.join(', ')}`);
    }
    // Profile management setup
    let profileRegistry = null;
    if (profilesEnabled) {
        logger.log('[Daemon] Profile management enabled');
        // Ensure ~/.supersurf/daemon/ exists
        fs_1.default.mkdirSync(path_1.default.join(SUPERSURF_DIR, 'daemon'), { recursive: true });
        // Pull extension from GitHub if not cached
        try {
            await (0, extension_source_1.ensureExtension)();
        }
        catch (err) {
            logger.log(`[Daemon] Warning: Failed to pull extension: ${err.message}`);
        }
        // Initialize profile registry
        profileRegistry = new registry_1.ProfileRegistry(path_1.default.join(SUPERSURF_DIR, 'profiles'));
        // Kill orphan Chromium processes from previous crash
        const entries = (0, chrome_1.replayPidLog)();
        const orphans = (0, chrome_1.findOrphanPids)(entries);
        if (orphans.length > 0) {
            logger.log(`[Daemon] Cleaning up ${orphans.length} orphan Chromium process(es)`);
            (0, chrome_1.killOrphanPids)(orphans);
        }
        (0, chrome_1.truncatePidLog)();
    }
    const version = getVersion();
    const ipc = new ipc_1.IPCServer(SOCK_FILE, bridge, sessions, scheduler, experiments, { port, version }, profileRegistry);
    // Idle timeout: exit after 10 minutes with no sessions
    let idleTimer = null;
    function resetIdleTimer() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    }
    function startIdleTimer() {
        resetIdleTimer();
        idleTimer = setTimeout(() => {
            logger.log('[Daemon] Idle timeout — no sessions for 10 minutes, exiting');
            shutdown();
        }, IDLE_TIMEOUT_MS);
    }
    ipc.setSessionCountCallback((count) => {
        logger.log(`[Daemon] Session count: ${count}`);
        if (count === 0) {
            startIdleTimer();
        }
        else {
            resetIdleTimer();
        }
    });
    // Graceful shutdown
    let shuttingDown = false;
    async function shutdown() {
        if (shuttingDown)
            return;
        shuttingDown = true;
        logger.log('[Daemon] Shutting down...');
        resetIdleTimer();
        // Kill all managed Chromium processes
        if (profileRegistry) {
            const profiles = profileRegistry.list();
            for (const p of profiles) {
                const pid = profileRegistry.getRunningPid(p.name);
                if (pid !== null) {
                    try {
                        process.kill(pid, 'SIGTERM');
                        logger.log(`[Daemon] Killed Chromium for profile "${p.name}" (pid ${pid})`);
                        (0, chrome_1.appendPidLog)({ action: 'kill', profile: p.name, pid, ts: new Date().toISOString() });
                    }
                    catch { }
                    profileRegistry.clearRunningPid(p.name);
                }
            }
        }
        scheduler.drainAll();
        await ipc.stop();
        await bridge.stop();
        cleanupFiles();
        logger.log('[Daemon] Shutdown complete');
        process.exit(0);
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    // Start extension WebSocket server
    try {
        await bridge.start();
        logger.log(`[Daemon] Extension WebSocket listening on port ${port}`);
    }
    catch (error) {
        console.error(`Failed to start extension WebSocket: ${error.message}`);
        cleanupFiles();
        process.exit(1);
    }
    // Start IPC server
    try {
        await ipc.start();
        logger.log(`[Daemon] IPC listening on ${SOCK_FILE}`);
    }
    catch (error) {
        console.error(`Failed to start IPC server: ${error.message}`);
        await bridge.stop();
        cleanupFiles();
        process.exit(1);
    }
    // Start idle timer (no sessions yet)
    startIdleTimer();
    logger.log('[Daemon] Daemon ready');
}
// Only run when executed directly (not imported by tests)
const isDirectRun = !process.env.VITEST;
if (isDirectRun) {
    main().catch((error) => {
        console.error('Daemon fatal error:', error);
        cleanupFiles();
        process.exit(1);
    });
}
//# sourceMappingURL=main.js.map