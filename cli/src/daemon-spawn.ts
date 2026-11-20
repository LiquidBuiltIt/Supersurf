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
import { spawnSync } from 'node:child_process';
import { supersurfDir, sockPath, pidPath, isDaemonRunning, isSocketLive, devSource, findShimBinary, probeShim, readRelaySwitch } from 'shared';
import { packageCommand } from './shell-out';

export { isDaemonRunning };

export function getSockPath(): string { return sockPath(); }
export function getPidPath(): string { return pidPath(); }

/**
 * Ensure a daemon is up. Shells out to the pinned daemon package's own `start`,
 * which detaches itself, then polls for the socket for up to 30s — the sanity
 * threshold item 26 set for a healthy system, generous enough to cover an npx
 * cold fetch of the daemon tarball.
 */
export async function ensureDaemon(port: number = 5555): Promise<void> {
  if (isDaemonRunning() && fs.existsSync(sockPath())) return;

  // A live pidfile without a socket is a daemon still starting: wait for it
  // rather than spawn a second one to race it for the pidfile lock.
  if (isDaemonRunning()) {
    if (await waitForSocket()) return;
    throw new Error(WAIT_FAILED);
  }

  // A daemon that lost its pidfile still listens: reuse it, never unlink its socket.
  if (await isSocketLive(sockPath())) return;

  try { if (fs.existsSync(sockPath())) fs.unlinkSync(sockPath()); } catch { /* stale */ }
  if (!fs.existsSync(supersurfDir())) fs.mkdirSync(supersurfDir(), { recursive: true });

  if (shimEnsure(port)) {
    if (await waitForSocket()) return;
    throw new Error(WAIT_FAILED);
  }

  const run = packageCommand('supersurf-daemon');
  const res = spawnSync(run.cmd, [...run.args, 'start', '--port', String(port)], {
    stdio: 'inherit',
  });
  if (res.error) {
    throw new Error(
      `Could not run \`${run.label} start\`: ${res.error.message}. ` +
      'Node.js and npx must be on PATH.',
    );
  }
  // `res.error` only covers spawn-level failure. If npx ran and exited non-zero
  // — unpublished version, registry 404, daemon crashing on start — surface
  // that now. Falling through would make the user wait out the 30s poll and
  // then point them at an empty daemon.log, hiding the npx error they just
  // watched scroll past on the inherited stderr.
  if (res.status !== 0) {
    throw new Error(
      `\`${run.label} start\` exited with status ${res.status}` +
      `${res.signal ? ` (signal ${res.signal})` : ''}. See the output above.`,
    );
  }

  if (await waitForSocket()) return;
  throw new Error(WAIT_FAILED);
}

/**
 * `agents.relay` on and a shim found: `supersurf-shim ensure --port <port>` starts the daemon.
 * False (after one stderr line when the shim was tried) means: start it the usual way.
 */
function shimEnsure(port: number): boolean {
  if (!readRelaySwitch([]).relay) return false;
  const bin = findShimBinary() ?? devSource('shim');
  if (!bin) return false;
  try {
    probeShim(bin);
    const r = spawnSync(bin, ['ensure', '--port', String(port)], { stdio: 'inherit' });
    if (!r.error && r.status === 0) return true;
  } catch { /* fall through to the warning */ }
  console.error('[supersurf] supersurf-shim ensure failed; starting the daemon the usual way.');
  return false;
}

const WAIT_FAILED =
  'Daemon failed to start within 30 seconds (socket never appeared). ' +
  'Check ~/.supersurf/logs/daemon.log.';

async function waitForSocket(): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(sockPath())) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
