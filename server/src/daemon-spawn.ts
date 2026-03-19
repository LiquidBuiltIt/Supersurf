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

  // Resolve the daemon — try local install first, then npx
  let command: string;
  let args: string[];

  try {
    const daemonPath = require.resolve('supersurf-daemon/dist/main.js');
    log('Daemon resolved locally:', daemonPath);
    command = process.execPath;
    args = [daemonPath, '--port', String(port)];
  } catch {
    log('Daemon not found locally, falling back to npx (will fetch from npm)');
    command = 'npx';
    args = ['supersurf-daemon@latest', '--port', String(port)];
  }

  if (debug) args.push('--debug');

  // Spawn via login shell so the daemon inherits the user's env vars
  // (e.g. SUPERSURF_EXPERIMENTS from .zshrc/.bashrc). MCP clients like
  // IDEs don't source shell profiles, so process.env is incomplete.
  const shell = process.env.SHELL || '/bin/zsh';
  const fullCmd = [command, ...args].map(a => `'${a}'`).join(' ');

  const env = { ...process.env };
  if (experiments.length > 0) {
    env.SUPERSURF_EXPERIMENTS = experiments.join(',');
  }

  const child = spawn(shell, ['-ilc', fullCmd], {
    detached: true,
    stdio: 'ignore',
    env,
  });

  child.unref();
  log(`Spawned daemon (pid=${child.pid}) via: ${fullCmd}`);

  // Poll for socket file (100ms interval, 10s timeout)
  const pollInterval = 100;
  const maxWait = 10000;
  let waited = 0;

  while (waited < maxWait) {
    if (fs.existsSync(SOCK_FILE)) {
      log('Daemon socket ready');
      return;
    }
    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
  }

  throw new Error('Daemon failed to start within 10 seconds');
}
