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
import { spawn, spawnSync } from 'child_process';
import {
  HARDCODED_DEFAULTS,
  daemonCommand,
  supersurfDir,
  sockPath,
  pidPath,
  readDaemonPid,
  isProcessAlive,
  findShimBinary,
} from 'shared';

export const SUPERSURF_DIR = supersurfDir();
export const PID_FILE = pidPath();
export const SOCK_FILE = sockPath();
export const LOG_FILE = path.join(SUPERSURF_DIR, 'logs', 'daemon.log');

// ─── CLI Parsing ──────────────────────────────────────────────

export function parseArgs(argv: string[]): { port: number; debug: boolean; verbose: boolean; command?: string; portExplicit: boolean; startReason: string; takeover?: number } {
  let port = HARDCODED_DEFAULTS.daemon.port;
  let portExplicit = false;
  let debug = false;
  let verbose = false;
  let command: string | undefined;
  let startReason: string | undefined;
  let spawnedByShim = false;
  let takeover: number | undefined;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      port = parseInt(argv[i + 1], 10);
      if (isNaN(port)) {
        console.error('Invalid port number');
        process.exit(1);
      }
      portExplicit = true;
      i++;
    } else if (argv[i] === '--takeover' && argv[i + 1]) {
      // Hand-off successor: the old daemon's pid. Anything but a positive integer is ignored.
      const n = Number(argv[i + 1]);
      if (Number.isInteger(n) && n > 0) takeover = n;
      i++;
    } else if (argv[i] === '--debug') {
      debug = true;
    } else if (argv[i] === '--verbose') {
      verbose = true;
    } else if (argv[i].startsWith('--start-reason=')) {
      startReason = argv[i].slice('--start-reason='.length);
    } else if (argv[i] === '--spawned-by=shim') {
      spawnedByShim = true;
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

  // Only [a-z_]+ reaches the log line; anything else is not trusted.
  const reason = startReason !== undefined && /^[a-z_]+$/.test(startReason) ? startReason : spawnedByShim ? 'shim' : 'unknown';
  return { port, debug, verbose, command, portExplicit, startReason: reason, takeover };
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

    const pendingLine = status.upgradePending
      ? `Upgrade pending: ${status.upgradePending.from} -> ${status.upgradePending.to}; the daemon restarts when no agent is connected (${status.sessions.length} session${status.sessions.length === 1 ? '' : 's'}, legacy and shim counted together).`
      : null;
    if (verbose) {
      const version = status.version || getVersion();
      console.log(`SuperSurf Daemon v${version}`);
      if (pendingLine) console.log(pendingLine);
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
      if (pendingLine) console.log(pendingLine);
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
  const tail = spawn('tail', ['-F', LOG_FILE], { stdio: 'inherit' });
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


/** The `supersurf-daemon` package root: the nearest `package.json` above this file with that name. */
export function daemonPackageRoot(): string {
  let dir = __dirname;
  for (;;) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'supersurf-daemon') return dir;
    } catch { /* no package.json here */ }
    const up = path.dirname(dir);
    if (up === dir) throw new Error('supersurf-daemon package root not found');
    dir = up;
  }
}

/** Send `daemon_restart` and wait for the one reply line (`timeoutMs` covers the whole hand-off). */
function requestHandoff(timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCK_FILE);
    let buf = '';
    const t = setTimeout(() => { socket.destroy(); reject(new Error(`no reply from the daemon in ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'daemon_restart' }) + '\n'));
    socket.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i === -1) return;
      clearTimeout(t);
      socket.destroy();
      try { resolve(JSON.parse(buf.slice(0, i))); } catch { reject(new Error('invalid reply from the daemon')); }
    });
    // The old daemon ends the socket after its reply; no reply line before that is a failure.
    socket.on('close', () => { clearTimeout(t); reject(new Error('the daemon closed the connection without a reply')); });
    socket.on('error', (err) => { clearTimeout(t); reject(err); });
  });
}

/**
 * `restart`. Returns `'start'` when the caller must stop the daemon (if any) and start a fresh one
 * the old way, or the process exit code when the gated hand-off path handled it.
 * Gate: a running 5.x daemon (reply has `protocol`) with the shim model in use, or a live shim session.
 */
export async function restartDaemon(port: number): Promise<'start' | 0 | 1> {
  let status: any;
  try { status = await queryDaemonStatus(false); } catch { return 'start'; }
  const gated = typeof status?.protocol === 'number' && (status.shimModel === true || (status.shimSessions ?? 0) > 0);
  if (!gated) return 'start';

  const root = daemonPackageRoot();
  const shimBin = findShimBinary(root);
  if (!shimBin && (status.shimSessions ?? 0) === 0) {
    console.log('supersurf-shim not found; no shim session is live, so the daemon restarts by stop and start.');
    return 'start';
  }
  if (!shimBin) {
    console.error('supersurf-shim not found (set SUPERSURF_SHIM_BIN, or install a SuperSurf build that ships it); the daemon was not restarted.');
    return 1;
  }
  const ens = spawnSync(shimBin, ['ensure', '--install', root, '--port', String(status.port ?? port)], { encoding: 'utf8', timeout: 60_000 });
  if (ens.status !== 0) {
    console.error(`supersurf-shim ensure failed${ens.error ? `: ${ens.error.message}` : ''}; the daemon was not restarted.`);
    if (ens.stderr) console.error(ens.stderr.trim());
    return 1;
  }

  let reply: any;
  try { reply = await requestHandoff(30_000); } catch (err: any) {
    console.error(`Restart failed: ${err.message}. Check ${LOG_FILE}.`);
    return 1;
  }
  if (reply?.type === 'handoff_committed') {
    console.log(`Daemon restarted (pid ${status.pid} -> ${reply.pid}). Legacy sessions on that daemon have ended; shim sessions reconnect by themselves.`);
    return 0;
  }
  if (reply?.type === 'handoff_failed') {
    console.error(`Restart failed: ${reply.reason}. The old daemon keeps running.`);
    if (reply.startupLog) console.error(reply.startupLog);
    return 1;
  }
  if (reply?.type === 'handoff_in_progress') {
    console.error('A restart or shutdown is already in progress; try again in a moment.');
    return 1;
  }
  console.error(`Restart failed: unexpected reply ${JSON.stringify(reply?.type)}.`);
  return 1;
}
