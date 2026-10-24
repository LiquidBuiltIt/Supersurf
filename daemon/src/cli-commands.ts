/**
 * Daemon CLI subcommands (`status`, `stop`, `observe`), argument parsing and
 * the daemon path constants. Moved out of main.ts; imports nothing from it,
 * so importing this module never reaches main.ts's entry block.
 *
 * @module cli-commands
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import {
  HARDCODED_DEFAULTS,
  daemonCommand,
  supersurfDir,
  sockPath,
  pidPath,
  readDaemonPid,
  isProcessAlive,
} from 'shared';

export const SUPERSURF_DIR = supersurfDir();
export const PID_FILE = pidPath();
export const SOCK_FILE = sockPath();
export const LOG_FILE = path.join(SUPERSURF_DIR, 'logs', 'daemon.log');

// ─── CLI Parsing ──────────────────────────────────────────────

export function parseArgs(argv: string[]): { port: number; debug: boolean; verbose: boolean; command?: string; portExplicit: boolean } {
  let port = HARDCODED_DEFAULTS.daemon.port;
  let portExplicit = false;
  let debug = false;
  let verbose = false;
  let command: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      port = parseInt(argv[i + 1], 10);
      if (isNaN(port)) {
        console.error('Invalid port number');
        process.exit(1);
      }
      portExplicit = true;
      i++;
    } else if (argv[i] === '--debug') {
      debug = true;
    } else if (argv[i] === '--verbose') {
      verbose = true;
    } else if (argv[i] === 'start') {
      command = 'start';
    } else if (argv[i] === 'stop') {
      command = 'stop';
    } else if (argv[i] === 'restart') {
      command = 'restart';
    } else if (argv[i] === 'status') {
      command = 'status';
    } else if (argv[i] === 'observe') {
      command = 'observe';
    }
  }

  return { port, debug, verbose, command, portExplicit };
}

// ─── Status Command ──────────────────────────────────────────

/** Query the daemon over the Unix socket for live state. */
export function queryDaemonStatus(verbose: boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCK_FILE)) {
      reject(new Error('Socket not found'));
      return;
    }

    const socket = net.createConnection(SOCK_FILE);
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
        } catch {
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
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/** Read package version from package.json */
export function getVersion(): string {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pkg.name === 'supersurf' || pkg.name === 'supersurf-daemon') {
        return pkg.version || 'unknown';
      }
    } catch { /* try next */ }
  }
  return 'unknown';
}

export async function printStatus(verbose: boolean): Promise<void> {
  const daemonRunning = fs.existsSync(PID_FILE);
  let pid: number | null = null;
  let alive = false;

  if (daemonRunning) {
    pid = readDaemonPid();
    alive = pid !== null && isProcessAlive(pid);
  }

  if (!alive) {
    console.log('Daemon not running');
    if (daemonRunning) console.log('(stale PID file found — will be cleaned on next start)');
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
      } else {
        for (const s of status.sessions) {
          const tab = s.attachedTabId ? `tab #${s.attachedTabId}` : 'no tab';
          const owned = `${s.ownedTabCount} owned tab${s.ownedTabCount !== 1 ? 's' : ''}`;
          console.log(`  ${s.sessionId}   ${tab}   ${owned}`);
        }
      }
      console.log('');
      console.log('Scheduler');
      console.log(`  Queue:      ${status.schedulerQueueDepth} pending`);
    } else {
      const version = status.version || getVersion();
      const ext = status.extensionConnected ? 'connected' : 'disconnected';
      console.log(`SuperSurf Daemon v${version} (pid ${pid})`);
      console.log(`  Uptime:      ${formatUptime(status.uptimeSeconds)}`);
      console.log(`  Extension:   ${ext}`);
      console.log(`  Sessions:    ${status.sessions.length} active`);
      console.log('');
      console.log(`Run \`${daemonCommand('status --verbose')}\` for full details.`);
    }
  } catch {
    // Fallback: socket query failed, show basic PID info
    console.log(`Daemon running (pid ${pid})`);
    console.log(`Socket: ${fs.existsSync(SOCK_FILE) ? SOCK_FILE : 'missing'}`);
  }

  process.exit(0);
}

// ─── Observe Command ─────────────────────────────────────────

export function observe(): void {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`Log file not found: ${LOG_FILE}`);
    process.exit(1);
  }

  console.log(`Tailing ${LOG_FILE} (Ctrl+C to stop)\n`);
  const tail = spawn('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
  tail.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => { tail.kill(); process.exit(0); });
}

// ─── Stop Command ───────────────────────────────────────────

/** Stop the running daemon by sending SIGTERM to the PID in the PID file. */
export function stopDaemon(): boolean {
  if (!fs.existsSync(PID_FILE)) {
    console.log('Daemon not running (no PID file)');
    return false;
  }

  const pid = readDaemonPid();
  if (pid === null) {
    console.log('Daemon not running (invalid PID file)');
    return false;
  }

  if (!isProcessAlive(pid)) {
    console.log(`Daemon not running (stale PID ${pid})`);
    // Clean up stale files
    try { fs.unlinkSync(PID_FILE); } catch {}
    try { fs.unlinkSync(SOCK_FILE); } catch {}
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: any) {
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
  } catch {}

  // Clean up files the hard way
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(SOCK_FILE); } catch {}
  return true;
}
