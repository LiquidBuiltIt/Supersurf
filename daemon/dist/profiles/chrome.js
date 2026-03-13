"use strict";
/**
 * Chromium process management — binary discovery, spawning, and PID tracking.
 *
 * @module profiles/chrome
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findChromiumBinary = findChromiumBinary;
exports.spawnChromium = spawnChromium;
exports.appendPidLog = appendPidLog;
exports.replayPidLog = replayPidLog;
exports.findOrphanPids = findOrphanPids;
exports.killOrphanPids = killOrphanPids;
exports.truncatePidLog = truncatePidLog;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
const SUPERSURF_DIR = path_1.default.join(os_1.default.homedir(), '.supersurf');
const PID_LOG_FILE = path_1.default.join(SUPERSURF_DIR, 'daemon', 'managed-pids.jsonl');
const debugLog = (...args) => {
    const logger = global.DAEMON_LOGGER;
    if (logger)
        logger.log('[Chrome]', ...args);
    else if (global.DAEMON_DEBUG)
        console.error('[Chrome]', ...args);
};
/** Known Chromium binary paths to check (macOS/Linux). */
const CHROMIUM_PATHS = [
    '/opt/homebrew/bin/chromium',
    '/usr/local/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
];
/**
 * Find the Chromium binary on the system.
 * Checks known paths, then falls back to `which chromium`.
 */
function findChromiumBinary() {
    for (const p of CHROMIUM_PATHS) {
        if (fs_1.default.existsSync(p))
            return p;
    }
    try {
        const result = (0, child_process_1.execSync)('which chromium', { stdio: 'pipe', encoding: 'utf8' }).trim();
        if (result)
            return result;
    }
    catch { }
    try {
        const result = (0, child_process_1.execSync)('which chromium-browser', { stdio: 'pipe', encoding: 'utf8' }).trim();
        if (result)
            return result;
    }
    catch { }
    return null;
}
/**
 * Spawn a Chromium instance for a managed profile.
 *
 * @param profileName - Profile name (used for user-data-dir path)
 * @param extensionDir - Path to the cached extension directory
 * @param port - Daemon port (for registration URL)
 * @param isFirstLaunch - If true, opens the registration URL as startup page
 * @returns The spawned ChildProcess
 */
function spawnChromium(profileName, extensionDir, port, isFirstLaunch) {
    const binary = findChromiumBinary();
    if (!binary) {
        throw new Error('Chromium not found — install via brew install chromium');
    }
    const userDataDir = path_1.default.join(SUPERSURF_DIR, 'profiles', profileName, 'chrome-data');
    fs_1.default.mkdirSync(userDataDir, { recursive: true });
    const args = [
        `--user-data-dir=${userDataDir}`,
        `--load-extension=${extensionDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--use-mock-keychain',
    ];
    if (isFirstLaunch) {
        args.push(`http://127.0.0.1:${port}/register/${profileName}`);
    }
    debugLog(`Spawning: ${binary} ${args.join(' ')}`);
    const child = (0, child_process_1.spawn)(binary, args, {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    debugLog(`Chromium spawned for profile "${profileName}" (pid ${child.pid})`);
    return child;
}
// ─── PID Log (crash recovery) ────────────────────────────────
/** Append a single entry to the PID log file. */
function appendPidLog(entry) {
    fs_1.default.mkdirSync(path_1.default.dirname(PID_LOG_FILE), { recursive: true });
    fs_1.default.appendFileSync(PID_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
}
/** Read and parse all entries from the PID log file. */
function replayPidLog() {
    if (!fs_1.default.existsSync(PID_LOG_FILE))
        return [];
    const entries = [];
    const lines = fs_1.default.readFileSync(PID_LOG_FILE, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            entries.push(JSON.parse(trimmed));
        }
        catch { }
    }
    return entries;
}
/** Replay spawn/kill events to find orphan PIDs (spawned but never killed). */
function findOrphanPids(entries) {
    const alive = new Set();
    for (const entry of entries) {
        if (entry.action === 'spawn') {
            alive.add(entry.pid);
        }
        else if (entry.action === 'kill') {
            alive.delete(entry.pid);
        }
    }
    return [...alive];
}
/** Kill orphan Chromium processes and log kill events. */
function killOrphanPids(pids) {
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGTERM');
            debugLog(`Killed orphan Chromium process: ${pid}`);
            appendPidLog({ action: 'kill', profile: 'orphan', pid, ts: new Date().toISOString() });
        }
        catch {
            debugLog(`Orphan process ${pid} already dead`);
        }
    }
}
/** Truncate the PID log file after cleanup. */
function truncatePidLog() {
    try {
        fs_1.default.writeFileSync(PID_LOG_FILE, '', 'utf8');
    }
    catch { }
}
//# sourceMappingURL=chrome.js.map