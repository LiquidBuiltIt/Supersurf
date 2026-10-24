#!/usr/bin/env node
"use strict";
/**
 * SuperSurf Daemon — standalone coordinator for multiple MCP sessions.
 *
 * Manages a single Chrome extension connection (WebSocket) and multiplexes
 * tool calls from multiple MCP servers (Unix domain socket).
 *
 * Usage (the daemon is not on PATH — see `daemonCommand` in shared/commands):
 *   npx supersurf-daemon@latest [start] [--port <n>] [--debug]
 *   npx supersurf-daemon@latest stop
 *   npx supersurf-daemon@latest restart [--port <n>] [--debug]
 *   npx supersurf-daemon@latest status
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
exports.IDLE_TIMEOUT_MS = exports.SOCK_FILE = exports.PID_FILE = exports.SUPERSURF_DIR = exports.getVersion = exports.formatUptime = exports.observe = exports.printStatus = exports.stopDaemon = exports.isProcessAlive = exports.parseArgs = void 0;
exports.cleanStaleFiles = cleanStaleFiles;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const crypto_1 = __importDefault(require("crypto"));
const child_process_1 = require("child_process");
const shared_1 = require("./shared");
Object.defineProperty(exports, "isProcessAlive", { enumerable: true, get: function () { return shared_1.isProcessAlive; } });
const extension_bridge_1 = require("./extension-bridge");
const session_1 = require("./session");
const scheduler_1 = require("./scheduler");
const ipc_1 = require("./ipc");
const index_1 = require("./experiments/index");
const registry_1 = require("./profiles/registry");
const extension_source_1 = require("./profiles/extension-source");
const chrome_1 = require("./profiles/chrome");
const cli_commands_1 = require("./cli-commands");
Object.defineProperty(exports, "SUPERSURF_DIR", { enumerable: true, get: function () { return cli_commands_1.SUPERSURF_DIR; } });
Object.defineProperty(exports, "PID_FILE", { enumerable: true, get: function () { return cli_commands_1.PID_FILE; } });
Object.defineProperty(exports, "SOCK_FILE", { enumerable: true, get: function () { return cli_commands_1.SOCK_FILE; } });
Object.defineProperty(exports, "parseArgs", { enumerable: true, get: function () { return cli_commands_1.parseArgs; } });
Object.defineProperty(exports, "formatUptime", { enumerable: true, get: function () { return cli_commands_1.formatUptime; } });
Object.defineProperty(exports, "getVersion", { enumerable: true, get: function () { return cli_commands_1.getVersion; } });
Object.defineProperty(exports, "printStatus", { enumerable: true, get: function () { return cli_commands_1.printStatus; } });
Object.defineProperty(exports, "observe", { enumerable: true, get: function () { return cli_commands_1.observe; } });
Object.defineProperty(exports, "stopDaemon", { enumerable: true, get: function () { return cli_commands_1.stopDaemon; } });
// Retained as a backwards-compatible export; runtime now reads the live value
// from ConfigService (cfg.get().daemon.idle_timeout_ms).
const IDLE_TIMEOUT_MS = shared_1.HARDCODED_DEFAULTS.daemon.idle_timeout_ms;
exports.IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MS;
// ─── PID File Management ──────────────────────────────────────
/** Clean stale PID/socket files if the referenced process is dead. */
function cleanStaleFiles() {
    if (fs_1.default.existsSync(cli_commands_1.PID_FILE)) {
        try {
            const pid = parseInt(fs_1.default.readFileSync(cli_commands_1.PID_FILE, 'utf8').trim(), 10);
            if (!isNaN(pid) && !(0, shared_1.isProcessAlive)(pid)) {
                fs_1.default.unlinkSync(cli_commands_1.PID_FILE);
                if (fs_1.default.existsSync(cli_commands_1.SOCK_FILE)) {
                    fs_1.default.unlinkSync(cli_commands_1.SOCK_FILE);
                }
            }
        }
        catch {
            // If we can't read the PID file, clean both
            try {
                fs_1.default.unlinkSync(cli_commands_1.PID_FILE);
            }
            catch { }
            try {
                fs_1.default.unlinkSync(cli_commands_1.SOCK_FILE);
            }
            catch { }
        }
    }
    else if (fs_1.default.existsSync(cli_commands_1.SOCK_FILE)) {
        // Orphaned socket file without a PID file — clean it
        try {
            fs_1.default.unlinkSync(cli_commands_1.SOCK_FILE);
        }
        catch { }
    }
}
/** Write current PID to the PID file. */
function writePidFile() {
    fs_1.default.writeFileSync(cli_commands_1.PID_FILE, String(process.pid), 'utf8');
}
/** Remove PID and socket files on shutdown. */
function cleanupFiles() {
    try {
        fs_1.default.unlinkSync(cli_commands_1.PID_FILE);
    }
    catch { }
    try {
        fs_1.default.unlinkSync(cli_commands_1.SOCK_FILE);
    }
    catch { }
}
// ─── Main ──────────────────────────────────────────────────────
async function main() {
    const { port: cliPort, debug, verbose, command, portExplicit } = (0, cli_commands_1.parseArgs)(process.argv);
    if (command === 'status') {
        await (0, cli_commands_1.printStatus)(verbose);
        return;
    }
    if (command === 'stop') {
        (0, cli_commands_1.stopDaemon)();
        return;
    }
    if (command === 'restart') {
        (0, cli_commands_1.stopDaemon)();
        // Fall through to start the daemon fresh
    }
    if (command === 'observe') {
        (0, cli_commands_1.observe)();
        return;
    }
    // Initialize ConfigService — scaffold ~/.supersurf/config.json on first run,
    // then merge CLI (port) + env + file inputs into a single resolved snapshot.
    const configPath = process.env.SUPERSURF_CONFIG_FILE
        || path_1.default.join(os_1.default.homedir(), '.supersurf', 'config.json');
    const scaffold = (0, shared_1.ensureConfigFile)(configPath);
    if (scaffold.created) {
        console.log(`[daemon] Scaffolded default config at ${configPath}`);
    }
    const { config: fileCfg, warnings: fileWarn } = (0, shared_1.loadJsonConfig)(configPath);
    const { config: envCfg, warnings: envWarn } = (0, shared_1.loadEnvConfig)(process.env);
    for (const w of [...fileWarn, ...envWarn])
        console.warn(`[daemon] ${w}`);
    const cfg = new shared_1.ConfigService({
        cli: portExplicit ? { daemon: { port: cliPort } } : {},
        env: envCfg,
        file: fileCfg,
        onWarn: (m) => console.warn(`[daemon] ${m}`),
    });
    const port = cfg.get().daemon.port;
    const idleTimeoutMs = cfg.get().daemon.idle_timeout_ms;
    // Initialize logger — always enabled for core events
    const logger = new shared_1.FileLogger(cli_commands_1.LOG_FILE);
    logger.enable();
    global.DAEMON_LOGGER = logger;
    if (debug) {
        global.DAEMON_DEBUG = true;
    }
    logger.log(`[Daemon] Starting daemon (port=${port}, pid=${process.pid})`);
    // Ensure ~/.supersurf/ exists
    if (!fs_1.default.existsSync(cli_commands_1.SUPERSURF_DIR)) {
        fs_1.default.mkdirSync(cli_commands_1.SUPERSURF_DIR, { recursive: true });
    }
    // Clean stale files from a crashed previous instance
    cleanStaleFiles();
    // Check if daemon is already running
    const existingPid = (0, shared_1.readDaemonPid)();
    if (existingPid !== null && (0, shared_1.isProcessAlive)(existingPid)) {
        console.error(`Daemon already running (pid ${existingPid})`);
        process.exit(1);
    }
    // Write PID file
    writePidFile();
    // Experiment defaults come from the resolved config snapshot (file + env merged).
    const expSnapshot = cfg.get().experiments;
    const version = (0, cli_commands_1.getVersion)();
    // Initialize components
    const bridge = new extension_bridge_1.ExtensionBridge(port, '127.0.0.1', version);
    const sessions = new session_1.SessionRegistry();
    const scheduler = new scheduler_1.RequestScheduler(bridge, sessions);
    const experiments = new index_1.DaemonExperimentRegistry({ defaults: expSnapshot });
    const enabledDefaults = Object.entries(expSnapshot)
        .filter(([, v]) => v === true)
        .map(([k]) => k);
    if (enabledDefaults.length > 0) {
        logger.log(`[Daemon] Experiment defaults: ${enabledDefaults.join(', ')}`);
    }
    // Ensure ~/.supersurf/daemon/ exists
    fs_1.default.mkdirSync(path_1.default.join(cli_commands_1.SUPERSURF_DIR, 'daemon'), { recursive: true });
    // Pull extension from GitHub if not cached. A failure is not fatal at
    // startup — a cached copy may still be usable, and unmanaged (bring-your-own
    // Chromium) sessions never touch this directory. But it IS fatal to a managed
    // profile spawn, so the reason is carried forward to spawnProfile rather than
    // being swallowed into daemon.log, where it only ever resurfaced as a
    // 45s match timeout with no cause attached.
    let extensionPullError = null;
    try {
        await (0, extension_source_1.ensureExtension)();
    }
    catch (err) {
        extensionPullError = err?.message ? String(err.message) : String(err);
        logger.log(`[Daemon] Failed to pull extension: ${extensionPullError}`);
        const cached = (0, extension_source_1.isExtensionCached)();
        // Note on reach: `daemon start` re-spawns itself via daemonize() with
        // stdio 'ignore', so this line is only visible on the foreground path.
        // Under the server it lands in daemon.startup.log, which is read only when
        // the daemon dies — and a pull failure is not fatal. The throw in
        // spawnProfile is therefore what actually reaches a human; this is the
        // cheap second surface, not the primary one.
        console.error(`SuperSurf: could not download the browser extension — ${extensionPullError}\n` +
            (cached
                ? `  Using the cached copy at ${(0, extension_source_1.getExtensionDir)()}. It may be out of date.`
                : `  No cached copy at ${(0, extension_source_1.getExtensionDir)()}. Managed profiles cannot start until this succeeds.`));
    }
    // Initialize profile registry
    const profileRegistry = new registry_1.ProfileRegistry(path_1.default.join(cli_commands_1.SUPERSURF_DIR, 'profiles'));
    // Kill orphan Chromium processes from previous crash
    const entries = (0, chrome_1.replayPidLog)();
    const orphans = (0, chrome_1.findOrphanPids)(entries);
    if (orphans.length > 0) {
        logger.log(`[Daemon] Cleaning up ${orphans.length} orphan Chromium process(es)`);
        (0, chrome_1.killOrphanPids)(orphans);
    }
    (0, chrome_1.truncatePidLog)();
    const startupOpts = {
        disableGpu: cfg.get().profiles.startup_opts.disable_gpu,
        chromePath: cfg.get().profiles.chrome_path,
    };
    const ipc = new ipc_1.IPCServer(cli_commands_1.SOCK_FILE, bridge, sessions, scheduler, experiments, profileRegistry, { port, version, startupOpts, extensionPullError });
    // Watch ~/.supersurf/config.json for post-startup edits. The daemon snapshots
    // config at startup and never hot-reloads — drift means the user's edits won't
    // take effect until restart. We surface this through the IPC envelope so the
    // server can warn the agent on the next response.
    const hashFile = (p) => {
        try {
            return crypto_1.default.createHash('sha256').update(fs_1.default.readFileSync(p)).digest('hex');
        }
        catch {
            return '';
        }
    };
    const initialHash = hashFile(configPath);
    try {
        fs_1.default.watch(configPath, { persistent: false }, () => {
            const current = hashFile(configPath);
            if (current && current !== initialHash) {
                ipc.setConfigDrift(true);
                logger.log('[Daemon] config.json changed since startup — restart required to apply');
            }
        });
    }
    catch (err) {
        logger.log(`[Daemon] Warning: failed to watch ${configPath}: ${err.message}`);
    }
    // Idle timeout: exit after the configured idle window with no sessions
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
            logger.log(`[Daemon] Idle timeout — no sessions for ${idleTimeoutMs}ms, exiting`);
            shutdown();
        }, idleTimeoutMs);
    }
    ipc.setSessionCountCallback((count) => {
        logger.log(`[Daemon] Session count: ${count}`);
        if (count === 0) {
            if (profileRegistry.hasUserOwnedRunning()) {
                // A human-opened browser is alive — idling out would strand it
                // (next daemon start could not adopt/kill it and connect latency
                // would suffer). Stay up; the Chromium exit handler re-invokes
                // this callback when the browser closes.
                logger.log('[Daemon] Idle timer suppressed — user-owned browser running');
            }
            else {
                startIdleTimer();
            }
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
        // Kill all managed Chromium processes — except user-owned ones
        // (launched via `supersurf profiles open`): the human closes those.
        const profiles = profileRegistry.list();
        for (const p of profiles) {
            const pid = profileRegistry.getRunningPid(p.name);
            if (pid !== null) {
                if (profileRegistry.isUserOwned(p.name)) {
                    logger.log(`[Daemon] Leaving user-owned Chromium for profile "${p.name}" (pid ${pid}) running`);
                    continue;
                }
                try {
                    process.kill(pid, 'SIGTERM');
                    logger.log(`[Daemon] Killed Chromium for profile "${p.name}" (pid ${pid})`);
                    (0, chrome_1.appendPidLog)({ action: 'kill', profile: p.name, pid, ts: new Date().toISOString() });
                }
                catch { }
                profileRegistry.clearRunningPid(p.name);
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
        logger.log(`[Daemon] IPC listening on ${cli_commands_1.SOCK_FILE}`);
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
/**
 * Self-daemonize: re-spawn this script as a detached background process,
 * then exit the parent so the daemon is not a child of the caller's shell.
 */
function daemonize(argv) {
    const args = argv.slice(2).filter(a => a !== 'start' && a !== 'restart');
    args.push('--_daemonized');
    const child = (0, child_process_1.spawn)(process.execPath, [__filename, ...args], {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    console.log(`Daemon started (pid ${child.pid})`);
    process.exit(0);
}
// Only run when executed directly (not imported by tests)
const isDirectRun = !process.env.VITEST;
if (isDirectRun) {
    const { command } = (0, cli_commands_1.parseArgs)(process.argv);
    const isDaemonized = process.argv.includes('--_daemonized');
    // Human-facing subcommands only (start/stop/restart/status/observe) — never the
    // detached background daemon child (--_daemonized) or a silent programmatic spawn
    // (e.g. ensureDaemon from the server), both of which have their stdio ignored anyway.
    if (command !== undefined && !isDaemonized) {
        const versionCheck = (0, shared_1.checkAndTouchVersionState)((0, cli_commands_1.getVersion)());
        if (versionCheck.shouldNotify) {
            console.log(shared_1.UPGRADE_NOTICE_MESSAGE);
        }
    }
    if (command === 'start' || command === 'restart') {
        // Explicit CLI command — self-daemonize (fork + exit parent)
        if (isDaemonized) {
            // We ARE the detached child — run the daemon
            main().catch(() => { cleanupFiles(); process.exit(1); });
        }
        else {
            if (command === 'restart')
                (0, cli_commands_1.stopDaemon)();
            daemonize(process.argv);
        }
    }
    else {
        // No start/restart command: either a query (status/stop/observe) or
        // programmatic spawn (e.g. ensureDaemon) — run main() directly
        main().catch((error) => {
            console.error('Daemon fatal error:', error);
            cleanupFiles();
            process.exit(1);
        });
    }
}
//# sourceMappingURL=main.js.map