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
import { supersurfDir, sockPath, pidPath, isDaemonRunning } from 'shared';
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

  try { if (fs.existsSync(sockPath())) fs.unlinkSync(sockPath()); } catch { /* stale */ }
  if (!fs.existsSync(supersurfDir())) fs.mkdirSync(supersurfDir(), { recursive: true });

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

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(sockPath())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    'Daemon failed to start within 30 seconds (socket never appeared). ' +
    'Check ~/.supersurf/logs/daemon.log.',
  );
}
