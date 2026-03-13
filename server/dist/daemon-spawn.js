"use strict";
/**
 * Daemon lifecycle utilities — spawn, detect, and connect to the daemon process.
 *
 * @module daemon-spawn
 * @exports isDaemonRunning - Check if daemon process is alive
 * @exports ensureDaemon - Spawn daemon if not running, wait for socket
 * @exports getSockPath - Return the daemon socket path
 * @exports getPidPath - Return the daemon PID file path
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSockPath = getSockPath;
exports.getPidPath = getPidPath;
exports.isDaemonRunning = isDaemonRunning;
exports.ensureDaemon = ensureDaemon;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
const logger_1 = require("./logger");
const log = (0, logger_1.createLog)('[Spawn]');
const SUPERSURF_DIR = path_1.default.join(os_1.default.homedir(), '.supersurf');
const PID_FILE = path_1.default.join(SUPERSURF_DIR, 'daemon.pid');
const SOCK_FILE = path_1.default.join(SUPERSURF_DIR, 'daemon.sock');
/** Return the path to the daemon's Unix socket. */
function getSockPath() {
    return SOCK_FILE;
}
/** Return the path to the daemon's PID file. */
function getPidPath() {
    return PID_FILE;
}
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
/**
 * Check if the daemon process is currently running.
 * Reads the PID file and verifies the process is alive.
 */
function isDaemonRunning() {
    if (!fs_1.default.existsSync(PID_FILE))
        return false;
    try {
        const pid = parseInt(fs_1.default.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (isNaN(pid))
            return false;
        return isProcessAlive(pid);
    }
    catch {
        return false;
    }
}
/**
 * Ensure the daemon is running. If not, spawn it and wait for the socket file.
 *
 * @param port - WebSocket port for the extension connection (default 5555)
 * @param debug - Enable daemon debug logging
 * @throws If daemon fails to start within 10 seconds
 */
async function ensureDaemon(port = 5555, debug = false, experiments = []) {
    if (isDaemonRunning() && fs_1.default.existsSync(SOCK_FILE)) {
        log('Daemon already running');
        return;
    }
    log('Daemon not running, spawning...');
    // Clean stale files
    try {
        if (fs_1.default.existsSync(SOCK_FILE))
            fs_1.default.unlinkSync(SOCK_FILE);
    }
    catch { }
    try {
        if (fs_1.default.existsSync(PID_FILE))
            fs_1.default.unlinkSync(PID_FILE);
    }
    catch { }
    // Ensure ~/.supersurf/ exists
    if (!fs_1.default.existsSync(SUPERSURF_DIR)) {
        fs_1.default.mkdirSync(SUPERSURF_DIR, { recursive: true });
    }
    // Resolve the daemon — try local install first, then npx
    let command;
    let args;
    try {
        const daemonPath = require.resolve('supersurf-daemon/dist/main.js');
        log('Daemon path (local):', daemonPath);
        command = process.execPath;
        args = [daemonPath, '--port', String(port)];
    }
    catch {
        // Not installed locally — use npx to fetch/run it
        log('Daemon not found locally, using npx');
        command = 'npx';
        args = ['supersurf-daemon@latest', '--port', String(port)];
    }
    if (debug)
        args.push('--debug');
    // Explicitly forward experiments to the daemon env so it doesn't depend
    // on env var inheritance from the MCP client (which is unreliable).
    const env = { ...process.env };
    if (experiments.length > 0) {
        env.SUPERSURF_EXPERIMENTS = experiments.join(',');
    }
    const child = (0, child_process_1.spawn)(command, args, {
        detached: true,
        stdio: 'ignore',
        env,
    });
    child.unref();
    log(`Spawned daemon (pid=${child.pid})`);
    // Poll for socket file (100ms interval, 10s timeout)
    const pollInterval = 100;
    const maxWait = 10000;
    let waited = 0;
    while (waited < maxWait) {
        if (fs_1.default.existsSync(SOCK_FILE)) {
            log('Daemon socket ready');
            return;
        }
        await new Promise(r => setTimeout(r, pollInterval));
        waited += pollInterval;
    }
    throw new Error('Daemon failed to start within 10 seconds');
}
//# sourceMappingURL=daemon-spawn.js.map