/**
 * Chromium process management — binary discovery, spawning, and PID tracking.
 *
 * @module profiles/chrome
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn, type ChildProcess } from 'child_process';
import type { FileLogger } from 'shared';
import type { PidLogEntry } from './types';

const SUPERSURF_DIR = path.join(os.homedir(), '.supersurf');
const PID_LOG_FILE = path.join(SUPERSURF_DIR, 'daemon', 'managed-pids.jsonl');

const debugLog = (...args: unknown[]) => {
  const logger = (global as any).DAEMON_LOGGER as FileLogger | undefined;
  if (logger) logger.log('[Chrome]', ...args);
  else if ((global as any).DAEMON_DEBUG) console.error('[Chrome]', ...args);
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
export function isSnapBinary(binPath: string): boolean {
  try {
    return fs.realpathSync(binPath).startsWith('/snap/');
  } catch {
    return false;
  }
}

/** Collect every Chromium-family binary on the system (Snap or otherwise). */
function collectCandidates(): string[] {
  const candidates: string[] = [];
  for (const p of CHROMIUM_PATHS) {
    if (fs.existsSync(p) && !candidates.includes(p)) candidates.push(p);
  }
  for (const name of WHICH_NAMES) {
    try {
      const result = execSync(`which ${name}`, { stdio: 'pipe', encoding: 'utf8' }).trim();
      if (result && !candidates.includes(result)) candidates.push(result);
    } catch {}
  }
  return candidates;
}

/**
 * Find a usable Chromium-family binary on the system.
 * Prefers non-Snap binaries — Snap-confined Chromium cannot access ~/.supersurf/.
 */
export function findChromiumBinary(): string | null {
  for (const c of collectCandidates()) {
    if (!isSnapBinary(c)) return c;
  }
  return null;
}

/** True when the only Chromium-family binaries on the system are Snap-confined. */
export function isSnapOnlySystem(): boolean {
  const candidates = collectCandidates();
  return candidates.length > 0 && candidates.every(isSnapBinary);
}

/** Build a platform-aware error message for when no usable Chromium is found. */
function buildChromiumNotFoundError(): string {
  if (isSnapOnlySystem()) {
    return [
      'Only Snap Chromium found — Snap confinement blocks access to ~/.supersurf/.',
      'Fix on Mint:    sudo snap remove chromium && sudo apt install chromium',
      'Fix on Ubuntu:  sudo snap remove chromium, then install google-chrome-stable from Google\'s apt repo',
    ].join('\n');
  }
  if (os.platform() === 'darwin') {
    return 'Chromium not found — install via: brew install chromium';
  }
  return [
    'Chromium not found on PATH.',
    'Install on Mint:    sudo apt install chromium',
    'Install on Ubuntu:  install google-chrome-stable from Google\'s apt repo',
  ].join('\n');
}

/** Optional Chromium spawn flags resolved from ConfigService. */
export interface StartupOpts {
  disableGpu?: boolean;
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
export function spawnChromium(
  profileName: string,
  extensionDir: string,
  port: number,
  openRegistration: boolean,
  startupOpts: StartupOpts = {},
): ChildProcess {
  const binary = findChromiumBinary();
  if (!binary) {
    throw new Error(buildChromiumNotFoundError());
  }

  // Validate extension dir is populated. If ensureExtension() failed on
  // daemon startup (network down, GitHub unreachable), --load-extension
  // silently launches Chrome without the extension and the matchmaker waits
  // forever. Fail loud here instead.
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    throw new Error(
      `Extension not found at ${extensionDir}/manifest.json. ` +
      `Daemon failed to download the extension from GitHub on startup. ` +
      `Check ~/.supersurf/logs/daemon.log for the original error, ` +
      `then restart the daemon: supersurf-daemon restart`,
    );
  }

  const userDataDir = path.join(SUPERSURF_DIR, 'profiles', profileName, 'chrome-data');
  fs.mkdirSync(userDataDir, { recursive: true });

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

  const child = spawn(binary, args, {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  debugLog(`Chromium spawned for profile "${profileName}" (pid ${child.pid})`);
  return child;
}

// ─── PID Log (crash recovery) ────────────────────────────────

/** Append a single entry to the PID log file. */
export function appendPidLog(entry: PidLogEntry): void {
  fs.mkdirSync(path.dirname(PID_LOG_FILE), { recursive: true });
  fs.appendFileSync(PID_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

/** Read and parse all entries from the PID log file. */
export function replayPidLog(): PidLogEntry[] {
  if (!fs.existsSync(PID_LOG_FILE)) return [];

  const entries: PidLogEntry[] = [];
  const lines = fs.readFileSync(PID_LOG_FILE, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {}
  }
  return entries;
}

/**
 * Replay spawn/kill events to find orphan PIDs (spawned but never killed).
 * User-owned spawns (`owner: 'user'`) are excluded — the daemon never reaps
 * a browser the human opened; they close it themselves.
 */
export function findOrphanPids(entries: PidLogEntry[]): number[] {
  const alive = new Map<number, PidLogEntry>();
  for (const entry of entries) {
    if (entry.action === 'spawn') {
      alive.set(entry.pid, entry);
    } else if (entry.action === 'kill') {
      alive.delete(entry.pid);
    }
  }
  return [...alive.values()].filter((e) => e.owner !== 'user').map((e) => e.pid);
}

/** Kill orphan Chromium processes and log kill events. */
export function killOrphanPids(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      debugLog(`Killed orphan Chromium process: ${pid}`);
      appendPidLog({ action: 'kill', profile: 'orphan', pid, ts: new Date().toISOString() });
    } catch {
      debugLog(`Orphan process ${pid} already dead`);
    }
  }
}

/** Truncate the PID log file after cleanup. */
export function truncatePidLog(): void {
  try {
    fs.writeFileSync(PID_LOG_FILE, '', 'utf8');
  } catch {}
}
