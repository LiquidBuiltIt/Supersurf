import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION } from '../src/version';

/**
 * `ensureDaemon` shells out via `spawnSync`, not `spawn` — follows the
 * child_process-mocking convention already established in
 * cli/tests/playbook-cli.test.ts (spread the real module, replace only the
 * one function under test, track invocations in a closure array) rather than
 * inventing a second style in the same suite.
 *
 * `result` is mutated per-test to drive spawnSync's return shape. When it
 * reports a clean exit, the mock also drops the socket file into place: a
 * real `npx supersurf-daemon start` self-daemonizes and only THEN does the
 * socket appear, but modelling that race with real timers would make these
 * tests slow and flaky for no benefit — what's under test is ensureDaemon's
 * reaction to spawnSync's result, not the poll loop's timing.
 */
const spawned: { cmd: string; args: string[] }[] = [];
const result: { status: number | null; signal: NodeJS.Signals | null; error?: Error } = {
  status: 0,
  signal: null,
  error: undefined,
};
let sockPath = '';
let currentTmpHome = '';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn((cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      if (result.error) {
        return { error: result.error, status: null, signal: null } as any;
      }
      if (result.status === 0) {
        try { fs.writeFileSync(sockPath, ''); } catch { /* dir not ready */ }
      }
      return { status: result.status, signal: result.signal } as any;
    }),
  };
});

// daemon-spawn.ts imports `* as os from 'node:os'` and reads os.homedir() at
// MODULE LOAD TIME to build its PID_FILE/SOCK_FILE constants. A native ESM
// import of a Node builtin yields a frozen namespace object (vi.spyOn throws
// "Cannot redefine property" on it), unlike a plain `require('os')` — so this
// redirects homedir() at the module-mock level instead, which works
// regardless of how the source imports it, then vi.resetModules() + a
// dynamic re-import (below) makes daemon-spawn.ts re-evaluate those
// constants against the redirected home.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => currentTmpHome,
  };
});

describe('ensureDaemon', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-spawn-test-'));
    currentTmpHome = tmpHome;
    vi.resetModules();
    spawned.length = 0;
    result.status = 0;
    result.signal = null;
    result.error = undefined;
    sockPath = path.join(tmpHome, '.supersurf', 'daemon.sock');
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('does not throw on a clean exit, and pins the spawned target to VERSION, never @latest', async () => {
    const { ensureDaemon } = await import('../src/daemon-spawn');
    await expect(ensureDaemon(5555)).resolves.toBeUndefined();
    expect(spawned[0].cmd).toBe('npx');
    expect(spawned[0].args).toContain(`supersurf-daemon@${VERSION}`);
    expect(spawned[0].args.join(' ')).not.toContain('@latest');
  });

  it('throws naming the exit status and the pinned package on a non-zero exit', async () => {
    result.status = 3;
    const { ensureDaemon } = await import('../src/daemon-spawn');
    let message = '';
    try {
      await ensureDaemon(5555);
      throw new Error('expected ensureDaemon to throw');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('status 3');
    expect(message).toContain(`npx supersurf-daemon@${VERSION}`);
    expect(message).not.toContain('@latest');
  });

  it('names the signal when the child is killed instead of exiting', async () => {
    result.status = null;
    result.signal = 'SIGKILL';
    const { ensureDaemon } = await import('../src/daemon-spawn');
    let message = '';
    try {
      await ensureDaemon(5555);
      throw new Error('expected ensureDaemon to throw');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('SIGKILL');
  });

  it('surfaces a spawn-level error (e.g. npx not on PATH) instead of falling through to the status check', async () => {
    result.error = new Error('spawn npx ENOENT');
    const { ensureDaemon } = await import('../src/daemon-spawn');
    let message = '';
    try {
      await ensureDaemon(5555);
      throw new Error('expected ensureDaemon to throw');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('ENOENT');
    expect(message).not.toContain('exited with status');
  });
});
