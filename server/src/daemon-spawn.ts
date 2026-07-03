/**
 * Daemon lifecycle utilities — spawn, detect, and connect to the daemon process.
 *
 * @module daemon-spawn
 * @exports isDaemonRunning - Check if daemon process is alive
 * @exports ensureDaemon - Spawn daemon if not running, wait for socket
 * @exports getSockPath - Return the daemon socket path
 * @exports getPidPath - Return the daemon PID file path
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { createLog } from './logger';

const log = createLog('[Spawn]');

const SUPERSURF_DIR = path.join(os.homedir(), '.supersurf');
const PID_FILE = path.join(SUPERSURF_DIR, 'daemon.pid');
const SOCK_FILE = path.join(SUPERSURF_DIR, 'daemon.sock');
/** Captures the spawned daemon's stderr so a startup failure (e.g. EADDRINUSE)
 *  is not swallowed by `stdio: 'ignore'`. Truncated on every spawn attempt. */
const STARTUP_LOG = path.join(SUPERSURF_DIR, 'daemon.startup.log');

/**
 * Turn a captured daemon-startup-stderr blob into a single human-facing reason.
 * Recognizes the common wedged-port case (EADDRINUSE) and renders an actionable
 * message; otherwise returns the last non-empty line, or null if nothing useful.
 */
export function explainStartupFailure(raw: string, port: number): string | null {
  const text = (raw || '').trim();
  if (!text) return null;
  if (text.includes('EADDRINUSE')) {
    return (
      `port ${port} is already in use (EADDRINUSE) — another process (likely a ` +
      `stale/wedged daemon) is holding it. Stop it with \`npx supersurf-daemon@latest stop\` ` +
      `(or kill whatever is bound to ${port}), then retry.`
    );
  }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

/** Return the path to the daemon's Unix socket. */
export function getSockPath(): string {
  return SOCK_FILE;
}

/** Return the path to the daemon's PID file. */
export function getPidPath(): string {
  return PID_FILE;
}

/** Check if a process with the given PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the daemon process is currently running.
 * Reads the PID file and verifies the process is alive.
 */
export function isDaemonRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isNaN(pid)) return false;
    return isProcessAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Resolve the daemon entry script. The daemon ships as a SEPARATE package
 * (`supersurf-daemon`), declared as a dependency of supersurf-mcp, so it
 * resolves from node_modules in a published install and via the workspace
 * symlink in local dev. Never fetched from the network, never bundled.
 */
export function resolveDaemonEntry(): string {
  try {
    return require.resolve('supersurf-daemon/dist/main.js');
  } catch {
    throw new Error(
      `Daemon entry not found. The 'supersurf-daemon' package must be installed ` +
      `(it is a dependency of supersurf-mcp). Run 'npm install' or rebuild with 'npm run build'.`,
    );
  }
}

/**
 * Ensure the daemon is running. If not, spawn it and wait for the socket file.
 *
 * @param port - WebSocket port for the extension connection (default 5555)
 * @param debug - Enable daemon debug logging
 * @throws If daemon fails to start within 10 seconds
 */
export async function ensureDaemon(port: number = 5555, debug: boolean = false, experiments: string[] = []): Promise<void> {
  if (isDaemonRunning() && fs.existsSync(SOCK_FILE)) {
    log('Daemon already running');
    return;
  }

  log('Daemon not running, spawning...');

  // Clean stale files
  try { if (fs.existsSync(SOCK_FILE)) fs.unlinkSync(SOCK_FILE); } catch {}
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {}

  // Ensure ~/.supersurf/ exists
  if (!fs.existsSync(SUPERSURF_DIR)) {
    fs.mkdirSync(SUPERSURF_DIR, { recursive: true });
  }

  // Resolve the daemon from inside this package — never from the network.
  const daemonPath = resolveDaemonEntry();
  log('Daemon entry resolved:', daemonPath);
  const command: string = process.execPath;
  const args: string[] = [daemonPath, '--port', String(port)];

  if (debug) args.push('--debug');

  // Spawn via login shell so the daemon inherits the user's env vars
  // (e.g. SUPERSURF_EXPERIMENTS from .zshrc/.bashrc). MCP clients like
  // IDEs don't source shell profiles, so process.env is incomplete.
  const shell = process.env.SHELL || '/bin/bash';
  const fullCmd = [command, ...args].map(a => `'${a}'`).join(' ');

  const env = { ...process.env };
  if (experiments.length > 0) {
    env.SUPERSURF_EXPERIMENTS = experiments.join(',');
  }

  // Capture the daemon's stderr to a file so a startup failure (e.g. binding a
  // port already held by a wedged daemon → EADDRINUSE) is not silently lost to
  // `stdio: 'ignore'`. Without this, the daemon exits(1) on bind failure and the
  // poll loop below just times out blindly with no diagnostic.
  let errFd: number | undefined;
  try { errFd = fs.openSync(STARTUP_LOG, 'w'); } catch { errFd = undefined; }

  const child = spawn(shell, ['-ilc', fullCmd], {
    detached: true,
    stdio: ['ignore', 'ignore', errFd ?? 'ignore'],
    env,
  });

  // Watch for the daemon dying before it ever becomes ready. The child is the
  // login shell wrapping node; it exits with node's exit code, so a bind
  // failure surfaces here as a non-zero exit while the socket never appears.
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', () => { exited = { code: null, signal: null }; });

  child.unref();
  try { if (errFd !== undefined) fs.closeSync(errFd); } catch {}
  log(`Spawned daemon (pid=${child.pid}) via: ${fullCmd}`);

  // Poll for socket file (100ms interval, 10s timeout), but bail out the instant
  // the daemon process exits — no point waiting the full 10s for a socket that
  // will never appear.
  const pollInterval = 100;
  const maxWait = 10000;
  let waited = 0;

  while (waited < maxWait) {
    if (fs.existsSync(SOCK_FILE)) {
      log('Daemon socket ready');
      return;
    }
    if (exited) {
      const info = exited as { code: number | null; signal: NodeJS.Signals | null };
      let captured = '';
      try { captured = fs.readFileSync(STARTUP_LOG, 'utf8'); } catch {}
      const reason = explainStartupFailure(captured, port);
      const how = info.code != null ? `exit code ${info.code}`
        : info.signal != null ? `signal ${info.signal}`
        : 'spawn error';
      log('Daemon exited before becoming ready:', how, reason || '(no diagnostic)');
      throw new Error(
        `Daemon process exited before becoming ready (${how}). ` +
        (reason ?? `No diagnostic captured — see ${STARTUP_LOG} and ~/.supersurf/logs/daemon.log.`)
      );
    }
    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
  }

  throw new Error('Daemon failed to start within 10 seconds (socket never appeared, process still alive)');
}
