/**
 * E4 item 12, real processes: the gated `restart` CLI against a built daemon in a throwaway HOME on a
 * free port. A legacy daemon takes the old stop-and-start path; a shim-model daemon gets the hand-off
 * through `supersurf-server ensure --install` and `daemon_restart`. Needs `npm run build.daemon`; the
 * gated case also needs a Go toolchain (skipped with a reason otherwise).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DaemonRig, MAIN, REPO, DAEMON_PKG, PKG_VERSION, waitFor, sleep } from './helpers/real-daemon';
import { isProcessAlive } from 'shared';

const GO = [process.env.GO, '/home/claudebox/.local/go/bin/go', 'go']
  .filter((g): g is string => !!g)
  .find((g) => spawnSync(g, ['version'], { stdio: 'ignore' }).status === 0);
const missing = !fs.existsSync(MAIN);

let rig: DaemonRig;
let extra: string[] = [];
afterEach(() => { rig?.cleanup(); for (const d of extra) fs.rmSync(d, { recursive: true, force: true }); extra = []; });

/** A shim stand-in that records that it ran. */
function recorder(dir: string): { bin: string; ran: string } {
  const ran = path.join(dir, 'recorder.ran');
  const bin = path.join(dir, 'recorder.sh');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${ran}'\nexit 0\n`, { mode: 0o755 });
  return { bin, ran };
}

/** A fake daemon socket: answers `daemon_status` with `status` and `daemon_restart` with `restartReply`, and records every line type it got. */
function fakeDaemon(sock: string, status: object, restartReply?: object, vanishAfterStatus = false): Promise<{ got: string[]; close: () => void }> {
  const got: string[] = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.on('error', () => {});
    c.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        got.push(line.type);
        if (line.type === 'daemon_status') {
          c.write(JSON.stringify({ type: 'daemon_status', ...status }) + '\n');
          // The stop path starts a real daemon in this HOME next; it must find no live socket in its way.
          if (vanishAfterStatus) { server.close(); try { fs.unlinkSync(sock); } catch {} }
        }
        else if (line.type === 'daemon_restart' && restartReply) { c.write(JSON.stringify(restartReply) + '\n'); c.end(); }
      }
    });
  });
  return new Promise((resolve) => server.listen(sock, () => resolve({ got, close: () => server.close() })));
}

const SHIM = { pid: 4242, protocol: 1, shimModel: true, shimSessions: 1 };

describe.skipIf(missing)('restart CLI against a fake status socket (S3)', () => {

  it('a 4.x reply without `protocol`: the stop path, no ensure, no daemon_restart', async () => {
    rig = new DaemonRig();
    rig.port = await (await import('./helpers/real-daemon')).freePort();
    const rec = recorder(rig.home);
    const victim = spawn('sleep', ['300'], { stdio: 'ignore' });
    rig.extraPids.add(victim.pid!);
    fs.writeFileSync(rig.pidFile, String(victim.pid));
    const fake = await fakeDaemon(rig.sock, { pid: victim.pid, shimModel: true, shimSessions: 2 }, undefined, true);
    try {
      const r = await rig.cli(['restart', '--port', String(rig.port)], { SUPERSURF_SERVER_BIN: rec.bin });
      expect(r.out).toContain(`Daemon stopped (pid ${victim.pid})`);
      expect(fs.existsSync(rec.ran)).toBe(false);
      expect(fake.got).not.toContain('daemon_restart');
      // The CLI then starts a fresh daemon in this throwaway HOME: wait for its pidfile so cleanup kills it.
      await waitFor(() => { try { const p = parseInt(fs.readFileSync(rig.pidFile, 'utf8'), 10); if (p !== victim.pid) rig.extraPids.add(p); return p !== victim.pid; } catch { return false; } }, 10000, 'the new daemon.pid');
      expect(fs.existsSync(path.join(rig.daemonDir, 'entry'))).toBe(false);
    } finally { fake.close(); }
  }, 60000);

  it('handoff_failed: prints the reason and the startup log, exit 1', async () => {
    rig = new DaemonRig();
    const rec = recorder(rig.home);
    const fake = await fakeDaemon(rig.sock, { ...SHIM, port: 4321 }, { type: 'handoff_failed', reason: 'boom', startupLog: 'STARTUP-LOG-LINE' });
    try {
      const r = await rig.cli(['restart', '--port', '5001'], { SUPERSURF_SERVER_BIN: rec.bin });
      expect(r.code).toBe(1);
      expect(r.out).toContain('Restart failed: boom. The old daemon keeps running.');
      expect(r.out).toContain('STARTUP-LOG-LINE');
    } finally { fake.close(); }
  }, 30000);

  it('handoff_in_progress: says so, exit 1', async () => {
    rig = new DaemonRig();
    const rec = recorder(rig.home);
    const fake = await fakeDaemon(rig.sock, { ...SHIM, port: 4321 }, { type: 'handoff_in_progress' });
    try {
      const r = await rig.cli(['restart', '--port', '5001'], { SUPERSURF_SERVER_BIN: rec.bin });
      expect(r.code).toBe(1);
      expect(r.out).toContain('A restart or shutdown is already in progress');
    } finally { fake.close(); }
  }, 30000);

  it('ensure gets the daemon\'s reported port, not the CLI port (N-a)', async () => {
    rig = new DaemonRig();
    const rec = recorder(rig.home);
    const fake = await fakeDaemon(rig.sock, { ...SHIM, port: 4321 }, { type: 'handoff_in_progress' });
    try {
      await rig.cli(['restart', '--port', '5001'], { SUPERSURF_SERVER_BIN: rec.bin });
      const ran = fs.readFileSync(rec.ran, 'utf8');
      expect(ran).toContain('ensure --install');
      expect(ran).toContain('--port 4321');
      expect(ran).not.toContain('5001');
    } finally { fake.close(); }
  }, 30000);

  describe('shim binary reported by the daemon (shimBin)', () => {
    const NO_ENV = { SUPERSURF_SERVER_BIN: '' };
    const NOT_FOUND = 'supersurf-server not found (set SUPERSURF_SERVER_BIN, or install a SuperSurf build that ships it); the daemon was not restarted.';

    /** Live shim sessions and no usable binary: message, exit 1, only the status query reached the daemon. */
    async function expectNoBinaryRefusal(reported: (home: string) => string | undefined): Promise<void> {
      rig = new DaemonRig();
      const shimBin = reported(rig.home);
      const fake = await fakeDaemon(rig.sock, { ...SHIM, port: 4321, ...(shimBin ? { shimBin } : {}) });
      try {
        const r = await rig.cli(['restart', '--port', '5001'], NO_ENV);
        expect(r.code).toBe(1);
        expect(r.out).toContain(NOT_FOUND);
        expect(fake.got).toEqual(['daemon_status']);
      } finally { fake.close(); }
    }

    it('SUPERSURF_SERVER_BIN wins over a reported path: only the env binary runs', async () => {
      rig = new DaemonRig();
      const a = path.join(rig.home, 'reported'); fs.mkdirSync(a);
      const b = path.join(rig.home, 'env'); fs.mkdirSync(b);
      const reported = recorder(a);
      const fromEnv = recorder(b);
      const fake = await fakeDaemon(rig.sock, { ...SHIM, port: 4321, shimBin: reported.bin }, { type: 'handoff_in_progress' });
      try {
        await rig.cli(['restart', '--port', '5001'], { SUPERSURF_SERVER_BIN: fromEnv.bin });
        expect(fs.readFileSync(fromEnv.ran, 'utf8')).toContain('ensure --install');
        expect(fs.existsSync(reported.ran)).toBe(false);
      } finally { fake.close(); }
    }, 30000);

    it('a reported path is used when the env is unset: ensure runs with it, then daemon_restart', async () => {
      rig = new DaemonRig();
      const rec = recorder(rig.home);
      const fake = await fakeDaemon(rig.sock, { ...SHIM, port: 4321, shimBin: rec.bin }, { type: 'handoff_in_progress' });
      try {
        await rig.cli(['restart', '--port', '5001'], NO_ENV);
        const ran = fs.readFileSync(rec.ran, 'utf8');
        expect(ran).toContain('--version');
        expect(ran).toContain('ensure --install');
        expect(ran).toContain('--port 4321');
        expect(fake.got).toEqual(['daemon_status', 'daemon_restart']);
      } finally { fake.close(); }
    }, 30000);

    it('a reported path missing on disk, live shim sessions: no-binary refusal', async () => {
      await expectNoBinaryRefusal((home) => path.join(home, 'no-such-dir', 'supersurf-server'));
    }, 30000);

    it('a reported path missing on disk, no live shim session: stop and start', async () => {
      rig = new DaemonRig();
      rig.port = await (await import('./helpers/real-daemon')).freePort();
      const victim = spawn('sleep', ['300'], { stdio: 'ignore' });
      rig.extraPids.add(victim.pid!);
      fs.writeFileSync(rig.pidFile, String(victim.pid));
      const fake = await fakeDaemon(rig.sock, { pid: victim.pid, protocol: 1, shimModel: true, shimSessions: 0, shimBin: path.join(rig.home, 'gone') }, undefined, true);
      try {
        const r = await rig.cli(['restart', '--port', String(rig.port)], NO_ENV);
        expect(r.out).toContain('supersurf-server not found; no shim session is live, so the daemon restarts by stop and start.');
        expect(r.out).toContain(`Daemon stopped (pid ${victim.pid})`);
        expect(fake.got).not.toContain('daemon_restart');
        await waitFor(() => { try { const p = parseInt(fs.readFileSync(rig.pidFile, 'utf8'), 10); if (p !== victim.pid) rig.extraPids.add(p); return p !== victim.pid; } catch { return false; } }, 10000, 'the new daemon.pid');
      } finally { fake.close(); }
    }, 60000);

    it('a reported path that is not executable: no-binary refusal', async () => {
      await expectNoBinaryRefusal((home) => {
        const plain = path.join(home, 'plain-file');
        fs.writeFileSync(plain, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
        return plain;
      });
    }, 30000);

    it('a reported path whose --version fails: no-binary refusal, ensure never runs', async () => {
      rig = new DaemonRig();
      const bad = path.join(rig.home, 'bad.sh');
      const ran = path.join(rig.home, 'bad.ran');
      fs.writeFileSync(bad, `#!/bin/sh\necho "$@" >> '${ran}'\nexit 1\n`, { mode: 0o755 });
      const fake = await fakeDaemon(rig.sock, { ...SHIM, port: 4321, shimBin: bad });
      try {
        const r = await rig.cli(['restart', '--port', '5001'], NO_ENV);
        expect(r.code).toBe(1);
        expect(r.out).toContain(NOT_FOUND);
        expect(fs.readFileSync(ran, 'utf8').trim()).toBe('--version');
        expect(fake.got).toEqual(['daemon_status']);
      } finally { fake.close(); }
    }, 30000);

    it('no reported path and no env: no-binary refusal', async () => {
      await expectNoBinaryRefusal(() => undefined);
    }, 30000);

    it('a relative reported path is refused', async () => {
      await expectNoBinaryRefusal(() => 'supersurf-server');
    }, 30000);
  });
});

describe.skipIf(missing)('restart CLI (real daemon)', () => {
  it('legacy daemon: the old stop-and-start path; no ensure, no entry, no daemon_restart', async () => {
    rig = new DaemonRig();
    const rec = recorder(rig.home);
    const oldPid = await rig.start();
    expect((await rig.status()).shimModel).toBe(false);
    const r = await rig.cli(['restart', '--port', String(rig.port)], { SUPERSURF_SERVER_BIN: rec.bin });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Daemon stopped');
    expect(r.out).toContain('Daemon started');
    await waitFor(() => { try { return parseInt(fs.readFileSync(rig.pidFile, 'utf8'), 10) !== oldPid; } catch { return false; } }, 15000, 'a new daemon.pid');
    const newPid = parseInt(fs.readFileSync(rig.pidFile, 'utf8'), 10);
    expect(newPid).not.toBe(oldPid);
    expect(isProcessAlive(oldPid)).toBe(false);
    expect(fs.existsSync(rec.ran)).toBe(false);
    expect(fs.existsSync(path.join(rig.daemonDir, 'entry'))).toBe(false);
    expect(rig.spawns()).toEqual([]);
    expect(rig.daemonLog()).toContain('Shutting down (reason=SIGTERM)');
    expect(rig.daemonLog()).not.toContain('[Handoff]');
  }, 60000);

  it('shim model, no shim binary, no live shim session: says so and restarts by stop and start', async () => {
    rig = new DaemonRig();
    const oldPid = await rig.start([], { SUPERSURF_DISABLE_LEGACY_SERVER: '1' });
    expect((await rig.status()).shimModel).toBe(true);
    const r = await rig.cli(['restart', '--port', String(rig.port)], { SUPERSURF_SERVER_BIN: path.join(rig.home, 'no-such-shim') });
    expect(r.out).toContain('supersurf-server not found; no shim session is live, so the daemon restarts by stop and start.');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Daemon stopped');
    expect(r.out).toContain('Daemon started');
    await waitFor(() => { try { return parseInt(fs.readFileSync(rig.pidFile, 'utf8'), 10) !== oldPid; } catch { return false; } }, 15000, 'a new daemon.pid');
    expect(isProcessAlive(oldPid)).toBe(false);
    expect(rig.spawns()).toEqual([]);
    expect(rig.daemonLog()).not.toContain('[Handoff]');
  }, 60000);

  it('shim model, no shim binary, a live shim session: says so, exits 1, daemon untouched', async () => {
    rig = new DaemonRig();
    const fake = await fakeDaemon(rig.sock, { ...SHIM, port: 4321 });
    try {
      const r = await rig.cli(['restart', '--port', '5001'], { SUPERSURF_SERVER_BIN: path.join(rig.home, 'no-such-shim') });
      expect(r.code).toBe(1);
      expect(r.out).toContain('supersurf-server not found (set SUPERSURF_SERVER_BIN, or install a SuperSurf build that ships it); the daemon was not restarted.');
      expect(fake.got).toEqual(['daemon_status']);
    } finally { fake.close(); }
  }, 30000);

  it.skipIf(!GO)('shim model, real Go shim: ensure writes entry and ban_cleared, the hand-off commits, new pid', async () => {
    rig = new DaemonRig();
    const bd = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
    extra.push(bd);
    const shimBin = path.join(bd, 'supersurf-server');
    const b = spawnSync(GO!, ['build', '-o', shimBin, '.'], { cwd: path.join(REPO, 'server', 'shim'), encoding: 'utf8' });
    if (b.status !== 0) throw new Error(`go build failed: ${b.stderr}`);
    // `ensure --install` copies the whole package tree, and the dev tree holds sockets that parallel
    // tests create under daemon/.tmp-test (copy fails). Run the CLI from a clean package copy, as installed.
    const pkg = path.join(bd, 'pkg');
    fs.mkdirSync(pkg);
    fs.copyFileSync(path.join(DAEMON_PKG, 'package.json'), path.join(pkg, 'package.json'));
    fs.cpSync(path.join(DAEMON_PKG, 'dist'), path.join(pkg, 'dist'), { recursive: true });
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(pkg, 'node_modules'));
    // A banned target version: ensure must append ban_cleared.
    fs.writeFileSync(path.join(rig.daemonDir, 'spawns.jsonl'), JSON.stringify({ ts: Date.now(), pid: 0, entryVersion: PKG_VERSION, outcome: 'handoff_failed', reason: 'seeded' }) + '\n');
    const oldPid = await rig.start(['--spawned-by=shim']);
    // The rig sets SUPERSURF_DEV_ENVIRONMENT for the daemon; the shim would see it too and take the dev path (no entry, no versions/). This test is the installed path, so the CLI and its shim get it empty.
    const r = await rig.cli(['restart', '--port', String(rig.port)], { SUPERSURF_SERVER_BIN: shimBin, SUPERSURF_DEV_ENVIRONMENT: '' }, 60000, path.join(pkg, 'dist', 'main.js'));
    expect(r.out, r.out).toContain(`Daemon restarted (pid ${oldPid} -> `);
    expect(r.out).toContain('Legacy sessions on that daemon have ended; shim sessions reconnect by themselves.');
    expect(r.code).toBe(0);
    const newPid = parseInt(fs.readFileSync(rig.pidFile, 'utf8'), 10);
    expect(newPid).not.toBe(oldPid);
    expect(r.out).toContain(`-> ${newPid})`);
    expect(isProcessAlive(newPid)).toBe(true);
    await waitFor(() => !isProcessAlive(oldPid), 10000, 'the old daemon to exit');
    const entry = JSON.parse(fs.readFileSync(path.join(rig.daemonDir, 'entry'), 'utf8'));
    expect(entry.version).toBe(PKG_VERSION);
    expect(entry.main).toContain(path.join('versions', PKG_VERSION));
    const outcomes = rig.spawns().map((s) => s.outcome);
    expect(outcomes).toContain('ban_cleared');
    expect(outcomes).toContain('handoff_committed');
    expect((await rig.status()).pid).toBe(newPid);
  }, 90000);
});
