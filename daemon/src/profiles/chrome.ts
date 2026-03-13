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
export function findChromiumBinary(): string | null {
  for (const p of CHROMIUM_PATHS) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const result = execSync('which chromium', { stdio: 'pipe', encoding: 'utf8' }).trim();
    if (result) return result;
  } catch {}

  try {
    const result = execSync('which chromium-browser', { stdio: 'pipe', encoding: 'utf8' }).trim();
    if (result) return result;
  } catch {}

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
export function spawnChromium(
  profileName: string,
  extensionDir: string,
  port: number,
  isFirstLaunch: boolean,
): ChildProcess {
  const binary = findChromiumBinary();
  if (!binary) {
    throw new Error('Chromium not found — install via brew install chromium');
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

  if (isFirstLaunch) {
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

/** Replay spawn/kill events to find orphan PIDs (spawned but never killed). */
export function findOrphanPids(entries: PidLogEntry[]): number[] {
  const alive = new Set<number>();
  for (const entry of entries) {
    if (entry.action === 'spawn') {
      alive.add(entry.pid);
    } else if (entry.action === 'kill') {
      alive.delete(entry.pid);
    }
  }
  return [...alive];
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
