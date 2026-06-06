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
exports.isSnapBinary = isSnapBinary;
exports.findChromiumBinary = findChromiumBinary;
exports.isSnapOnlySystem = isSnapOnlySystem;
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
/** Known Chromium-family binary paths to check (macOS/Linux). */
const CHROMIUM_PATHS = [
    // macOS (Homebrew)
    '/opt/homebrew/bin/chromium',
    '/opt/homebrew/bin/google-chrome',
    '/usr/local/bin/chromium',
    '/usr/local/bin/google-chrome',
    // Linux (deb / system)
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/google-chrome',
];
/** Binary names to look up via `which` as a fallback after the path list. */
const WHICH_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
/**
 * Return true if the binary resolves to a path under /snap/.
 * Snap confinement blocks access to ~/.supersurf/ via AppArmor's home interface
 * (which excludes hidden directories), so Snap-packaged Chromium cannot run
 * managed profiles even though the binary itself launches fine.
 */
function isSnapBinary(binPath) {
    try {
        return fs_1.default.realpathSync(binPath).startsWith('/snap/');
    }
    catch {
        return false;
    }
}
/** Collect every Chromium-family binary on the system (Snap or otherwise). */
function collectCandidates() {
    const candidates = [];
    for (const p of CHROMIUM_PATHS) {
        if (fs_1.default.existsSync(p) && !candidates.includes(p))
            candidates.push(p);
    }
    for (const name of WHICH_NAMES) {
        try {
            const result = (0, child_process_1.execSync)(`which ${name}`, { stdio: 'pipe', encoding: 'utf8' }).trim();
            if (result && !candidates.includes(result))
                candidates.push(result);
        }
        catch { }
    }
    return candidates;
}
/**
 * Find a usable Chromium-family binary on the system.
 * Prefers non-Snap binaries — Snap-confined Chromium cannot access ~/.supersurf/.
 */
function findChromiumBinary() {
    for (const c of collectCandidates()) {
        if (!isSnapBinary(c))
            return c;
    }
    return null;
}
/** True when the only Chromium-family binaries on the system are Snap-confined. */
function isSnapOnlySystem() {
    const candidates = collectCandidates();
    return candidates.length > 0 && candidates.every(isSnapBinary);
}
/** Build a platform-aware error message for when no usable Chromium is found. */
function buildChromiumNotFoundError() {
    if (isSnapOnlySystem()) {
        return [
            'Only Snap Chromium found — Snap confinement blocks access to ~/.supersurf/.',
            'Fix on Mint:    sudo snap remove chromium && sudo apt install chromium',
            'Fix on Ubuntu:  sudo snap remove chromium, then install google-chrome-stable from Google\'s apt repo',
        ].join('\n');
    }
    if (os_1.default.platform() === 'darwin') {
        return 'Chromium not found — install via: brew install chromium';
    }
    return [
        'Chromium not found on PATH.',
        'Install on Mint:    sudo apt install chromium',
        'Install on Ubuntu:  install google-chrome-stable from Google\'s apt repo',
    ].join('\n');
}
/**
 * Spawn a Chromium instance for a managed profile.
 *
 * @param profileName - Profile name (used for user-data-dir path)
 * @param extensionDir - Path to the cached extension directory
 * @param port - Daemon port (for registration URL)
 * @param openRegistration - If true, opens the profile registration URL as the
 *   startup page. This re-arms the profile binding in the extension's
 *   chrome.storage.local on every spawn — not just the first — so an
 *   already-initialized profile whose storage lost `supersurf_profile`
 *   (force-kill, rsync'd profile, Chrome corruption) can still recover.
 * @param startupOpts - Optional Chromium flags from config (e.g. disableGpu for stability)
 * @returns The spawned ChildProcess
 */
function spawnChromium(profileName, extensionDir, port, openRegistration, startupOpts = {}) {
    const binary = findChromiumBinary();
    if (!binary) {
        throw new Error(buildChromiumNotFoundError());
    }
    // Validate extension dir is populated. If ensureExtension() failed on
    // daemon startup (network down, GitHub unreachable), --load-extension
    // silently launches Chrome without the extension and the matchmaker waits
    // forever. Fail loud here instead.
    if (!fs_1.default.existsSync(path_1.default.join(extensionDir, 'manifest.json'))) {
        throw new Error(`Extension not found at ${extensionDir}/manifest.json. ` +
            `Daemon failed to download the extension from GitHub on startup. ` +
            `Check ~/.supersurf/logs/daemon.log for the original error, ` +
            `then restart the daemon: supersurf-daemon restart`);
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
    if (startupOpts.disableGpu) {
        args.push('--disable-gpu');
    }
    if (openRegistration) {
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