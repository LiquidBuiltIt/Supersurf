/**
 * Daemon lifecycle for the compiled binary.
 *
 * A separate implementation from server/src/daemon-spawn.ts on purpose: that
 * one resolves the daemon entry through require.resolve('supersurf-daemon/...'),
 * which a compiled binary with no node_modules cannot do. This one shells out to
 * the pinned `npx supersurf-daemon@<ver> start`, which self-daemonizes, then
 * polls for the socket.
 *
 * @module daemon-spawn
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { npxTarget } from './shell-out';

const SUPERSURF_DIR = path.join(os.homedir(), '.supersurf');
const PID_FILE = path.join(SUPERSURF_DIR, 'daemon.pid');
const SOCK_FILE = path.join(SUPERSURF_DIR, 'daemon.sock');

export function getSockPath(): string { return SOCK_FILE; }
export function getPidPath(): string { return PID_FILE; }

export function isDaemonRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (Number.isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a daemon is up. Shells out to the pinned daemon package's own `start`,
 * which detaches itself, then polls for the socket for up to 30s — the sanity
 * threshold item 26 set for a healthy system, generous enough to cover an npx
 * cold fetch of the daemon tarball.
 */
export async function ensureDaemon(port: number = 5555): Promise<void> {
  if (isDaemonRunning() && fs.existsSync(SOCK_FILE)) return;

  try { if (fs.existsSync(SOCK_FILE)) fs.unlinkSync(SOCK_FILE); } catch { /* stale */ }
  if (!fs.existsSync(SUPERSURF_DIR)) fs.mkdirSync(SUPERSURF_DIR, { recursive: true });

  const res = spawnSync('npx', ['--yes', npxTarget('supersurf-daemon'), 'start', '--port', String(port)], {
    stdio: 'inherit',
  });
  if (res.error) {
    throw new Error(
      `Could not run \`npx ${npxTarget('supersurf-daemon')} start\`: ${res.error.message}. ` +
      'Node.js and npx must be on PATH.',
    );
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(SOCK_FILE)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    'Daemon failed to start within 30 seconds (socket never appeared). ' +
    'Check ~/.supersurf/logs/daemon.log.',
  );
}
