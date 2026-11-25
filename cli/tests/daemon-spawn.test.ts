import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
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
let shimBin = '';
const shimResult: { status: number | null; error?: Error } = { status: 0 };

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn((cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      if (shimBin && cmd === shimBin) {
        if (args[0] === '--version') return { status: 0, signal: null } as any; // the probe
        if (shimResult.error) return { error: shimResult.error, status: null, signal: null } as any;
        if (shimResult.status === 0) { try { fs.writeFileSync(sockPath, ''); } catch { /* dir not ready */ } }
        return { status: shimResult.status, signal: null } as any;
      }
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

// daemon-spawn.ts gets its paths from `shared`, which calls os.homedir() at
// CALL time, so setting process.env.HOME (what os.homedir() reads on
// Linux/macOS) in beforeEach redirects every path to tmpHome and a miss can
// never touch the developer's real ~/.supersurf.
const RELAY_KEYS = ['SUPERSURF_DISABLE_LEGACY_SERVER', 'SUPERSURF_SERVER_BIN', 'SUPERSURF_CONFIG_FILE', 'SUPERSURF_DEV_ENVIRONMENT'];

describe('ensureDaemon', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of RELAY_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    shimBin = '';
    shimResult.status = 0;
    shimResult.error = undefined;
    origHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-spawn-test-'));
    process.env.HOME = tmpHome;
    vi.resetModules();
    spawned.length = 0;
    result.status = 0;
    result.signal = null;
    result.error = undefined;
    sockPath = path.join(tmpHome, '.supersurf', 'daemon.sock');
  });

  afterEach(() => {
    for (const k of RELAY_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('does not throw on a clean exit, and pins the spawned target to VERSION, never @latest', async () => {
    const { ensureDaemon } = await import('../src/daemon-spawn');
    await expect(ensureDaemon(5555)).resolves.toBeUndefined();
    expect(spawned[0].cmd).toBe('npx');
    expect(spawned[0].args).toContain(`supersurf-daemon@${VERSION}`);
    expect(spawned[0].args.join(' ')).not.toContain('@latest');
  });

  it('waits for the socket of a daemon that is still starting instead of spawning a second one (M4)', async () => {
    const dir = path.join(tmpHome, '.supersurf');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'daemon.pid'), String(process.pid)); // alive, not listening yet
    setTimeout(() => fs.writeFileSync(sockPath, ''), 300);
    const { ensureDaemon } = await import('../src/daemon-spawn');
    await expect(ensureDaemon(5555)).resolves.toBeUndefined();
    expect(spawned).toHaveLength(0);
  });

  it('reuses a daemon that listens on the socket without a pidfile: no unlink, no spawn', async () => {
    const dir = path.join(tmpHome, '.supersurf');
    fs.mkdirSync(dir, { recursive: true });
    const live = net.createServer((c) => c.end());
    await new Promise<void>((r) => live.listen(sockPath, r));
    try {
      const { ensureDaemon } = await import('../src/daemon-spawn');
      await expect(ensureDaemon(5555)).resolves.toBeUndefined();
      expect(spawned).toHaveLength(0);
      expect(fs.existsSync(sockPath)).toBe(true);
      await new Promise<void>((resolve, reject) => {
        const c = net.createConnection(sockPath);
        c.once('connect', () => { c.destroy(); resolve(); });
        c.once('error', reject);
      });
    } finally {
      await new Promise((r) => live.close(r));
    }
  });

  it('still removes a dead socket file (nothing listening) and spawns', async () => {
    const dir = path.join(tmpHome, '.supersurf');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sockPath, '');
    const { ensureDaemon } = await import('../src/daemon-spawn');
    await expect(ensureDaemon(5555)).resolves.toBeUndefined();
    expect(spawned).toHaveLength(1);
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

  it('starts the clone\'s daemon under node when SUPERSURF_DEV_ENVIRONMENT routes it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-spawn-dev-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'supersurf' }));
    fs.mkdirSync(path.join(root, 'daemon/dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'daemon/dist/main.js'), '');
    process.env.SUPERSURF_DEV_ENVIRONMENT = root;
    try {
      const { ensureDaemon } = await import('../src/daemon-spawn');
      await expect(ensureDaemon(5555)).resolves.toBeUndefined();
      expect(spawned[0]).toEqual({
        cmd: 'node',
        args: [path.join(root, 'daemon/dist/main.js'), 'start', '--port', '5555'],
      });
    } finally {
      delete process.env.SUPERSURF_DEV_ENVIRONMENT;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  describe('server.legacy', () => {
    const legacy = () => spawned.filter((c) => c.cmd === 'npx' || c.cmd === 'node');
    const ensures = () => spawned.filter((c) => c.cmd === shimBin && c.args[0] === 'ensure');
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      shimBin = path.join(tmpHome, 'fake-shim');
      fs.writeFileSync(shimBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.SUPERSURF_SERVER_BIN = shimBin;
      warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    it('off: the shim never runs and the legacy spawn happens', async () => {
      const { ensureDaemon } = await import('../src/daemon-spawn');
      await ensureDaemon(5555);
      expect(spawned.filter((c) => c.cmd === shimBin)).toEqual([]);
      expect(legacy()).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('on + binary: runs `ensure --port <n>` and spawns no legacy daemon when it succeeds', async () => {
      process.env.SUPERSURF_DISABLE_LEGACY_SERVER = '1';
      const { ensureDaemon } = await import('../src/daemon-spawn');
      await expect(ensureDaemon(5599)).resolves.toBeUndefined();
      expect(ensures().map((c) => c.args)).toEqual([['ensure', '--port', '5599']]);
      expect(legacy()).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    });

    it('on + ensure fails: one warning line, then the legacy spawn', async () => {
      process.env.SUPERSURF_DISABLE_LEGACY_SERVER = '1';
      shimResult.status = 1;
      const { ensureDaemon } = await import('../src/daemon-spawn');
      await expect(ensureDaemon(5555)).resolves.toBeUndefined();
      expect(ensures()).toHaveLength(1);
      expect(warn.mock.calls).toEqual([['[supersurf] supersurf-server ensure failed; starting the daemon the usual way.']]);
      expect(legacy()).toHaveLength(1);
    });

    it('on + the shim cannot be spawned: warning, then the legacy spawn', async () => {
      process.env.SUPERSURF_DISABLE_LEGACY_SERVER = '1';
      shimResult.error = new Error('spawn EACCES');
      const { ensureDaemon } = await import('../src/daemon-spawn');
      await expect(ensureDaemon(5555)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(legacy()).toHaveLength(1);
    });

    it('on + port outside 1..65535: the shim is not run, one warning, then the legacy spawn', async () => {
      process.env.SUPERSURF_DISABLE_LEGACY_SERVER = '1';
      const { ensureDaemon } = await import('../src/daemon-spawn');
      await ensureDaemon(70000);
      expect(ensures()).toHaveLength(0);
      expect(warn.mock.calls).toEqual([['[supersurf] server.legacy is false but port 70000 is not in 1-65535; starting the daemon the usual way.']]);
      expect(legacy()).toHaveLength(1);
    });

    it('on, no binary: the legacy path exactly, no warning', async () => {
      process.env.SUPERSURF_DISABLE_LEGACY_SERVER = '1';
      process.env.SUPERSURF_SERVER_BIN = path.join(tmpHome, 'no-such-shim');
      const { ensureDaemon } = await import('../src/daemon-spawn');
      await ensureDaemon(5555);
      expect(ensures()).toHaveLength(0);
      expect(legacy()).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('on, daemon already running: the shim is not run', async () => {
      process.env.SUPERSURF_DISABLE_LEGACY_SERVER = '1';
      fs.mkdirSync(path.join(tmpHome, '.supersurf'), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, '.supersurf', 'daemon.pid'), String(process.pid));
      fs.writeFileSync(sockPath, '');
      const { ensureDaemon } = await import('../src/daemon-spawn');
      await ensureDaemon(5555);
      expect(spawned).toHaveLength(0);
    });
  });
});
