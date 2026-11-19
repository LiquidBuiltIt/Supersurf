/**
 * E4 item 12, real processes: the gated `restart` CLI against a built daemon in a throwaway HOME on a
 * free port. A legacy daemon takes the old stop-and-start path; a shim-model daemon gets the hand-off
 * through `supersurf-shim ensure --install` and `daemon_restart`. Needs `npm run build.daemon`; the
 * gated case also needs a Go toolchain (skipped with a reason otherwise).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
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

describe.skipIf(missing)('restart CLI (real daemon)', () => {
  it('legacy daemon: the old stop-and-start path; no ensure, no entry, no daemon_restart', async () => {
    rig = new DaemonRig();
    const rec = recorder(rig.home);
    const oldPid = await rig.start();
    expect((await rig.status()).shimModel).toBe(false);
    const r = await rig.cli(['restart', '--port', String(rig.port)], { SUPERSURF_SHIM_BIN: rec.bin });
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

  it('shim model, no shim binary: says so, exits 1, daemon untouched', async () => {
    rig = new DaemonRig();
    const pid = await rig.start(['--spawned-by=shim']);
    const r = await rig.cli(['restart', '--port', String(rig.port)], { SUPERSURF_SHIM_BIN: path.join(rig.home, 'no-such-shim') });
    expect(r.code).toBe(1);
    expect(r.out).toContain('supersurf-shim not found (set SUPERSURF_SHIM_BIN, or install a SuperSurf build that ships it); the daemon was not restarted.');
    await sleep(300);
    expect(isProcessAlive(pid)).toBe(true);
    expect((await rig.status()).pid).toBe(pid);
    expect(fs.existsSync(path.join(rig.daemonDir, 'entry'))).toBe(false);
  }, 30000);

  it.skipIf(!GO)('shim model, real Go shim: ensure writes entry and ban_cleared, the hand-off commits, new pid', async () => {
    rig = new DaemonRig();
    const bd = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
    extra.push(bd);
    const shimBin = path.join(bd, 'supersurf-shim');
    const b = spawnSync(GO!, ['build', '-o', shimBin, '.'], { cwd: path.join(REPO, 'shim'), encoding: 'utf8' });
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
    const r = await rig.cli(['restart', '--port', String(rig.port)], { SUPERSURF_SHIM_BIN: shimBin }, 60000, path.join(pkg, 'dist', 'main.js'));
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
