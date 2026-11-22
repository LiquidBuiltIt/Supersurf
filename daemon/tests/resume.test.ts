import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { snapshotPath, writeSnapshot, loadSnapshot, deleteSnapshot, browserMatches, procAvailable, type Snapshot } from '../src/resume';

let home: string;
let prevHome: string | undefined;

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  v: 1,
  oldpid: 4242,
  ts: 1_000_000,
  sessions: [{ id: 'a', shim: 'shim-1', ownedTabs: [1], createdTabs: [1], attachedTabId: null, groupId: null, profileId: 'dev', experiments: { page_diffing: true } }],
  browsers: [{ profile: 'dev', pid: 99 }],
  ...over,
});

beforeEach(() => {
  prevHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('snapshot file', () => {
  it('is ~/.supersurf/daemon/resume.json', () => {
    expect(snapshotPath()).toBe(path.join(home, '.supersurf', 'daemon', 'resume.json'));
  });

  it('writeSnapshot writes mode 0600 and leaves no tmp file', () => {
    writeSnapshot(snap());
    expect(fs.statSync(snapshotPath()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(snapshotPath() + '.tmp')).toBe(false);
    expect(JSON.parse(fs.readFileSync(snapshotPath(), 'utf8'))).toEqual(snap());
  });

  it('deleteSnapshot removes the file and reports whether there was one', () => {
    writeSnapshot(snap());
    expect(deleteSnapshot()).toBe(true);
    expect(deleteSnapshot()).toBe(false);
  });
});

describe('loadSnapshot', () => {
  it('returns the snapshot and always deletes the file', () => {
    writeSnapshot(snap());
    const r = loadSnapshot(4242, 1_000_500);
    expect(r).toEqual({ ok: true, snap: snap() });
    expect(fs.existsSync(snapshotPath())).toBe(false);
  });

  it('missing', () => {
    expect(loadSnapshot(4242, 1_000_500)).toEqual({ ok: false, reason: 'missing' });
  });

  it('corrupt (and deletes)', () => {
    fs.mkdirSync(path.dirname(snapshotPath()), { recursive: true });
    fs.writeFileSync(snapshotPath(), '{"v":1,"oldp');
    expect(loadSnapshot(4242, 1_000_500)).toEqual({ ok: false, reason: 'corrupt' });
    expect(fs.existsSync(snapshotPath())).toBe(false);
  });

  it('wrong_pid (and deletes)', () => {
    writeSnapshot(snap({ oldpid: 1 }));
    expect(loadSnapshot(4242, 1_000_500)).toEqual({ ok: false, reason: 'wrong_pid' });
    expect(fs.existsSync(snapshotPath())).toBe(false);
  });

  it('stale: older than maxAgeMs, and a timestamp in the future', () => {
    writeSnapshot(snap());
    expect(loadSnapshot(4242, 1_000_000 + 60_001)).toEqual({ ok: false, reason: 'stale' });
    writeSnapshot(snap());
    expect(loadSnapshot(4242, 999_999)).toEqual({ ok: false, reason: 'stale' });
    writeSnapshot(snap());
    expect(loadSnapshot(4242, 1_000_000 + 60_000).ok).toBe(true);
  });

  it('bad_shape: wrong version, wrong field types', () => {
    const bad = [
      { ...snap(), v: 2 },
      { ...snap(), sessions: 'x' },
      { ...snap(), browsers: [{ profile: 'dev', pid: 'nope' }] },
      { ...snap(), sessions: [{ ...snap().sessions[0], ownedTabs: ['1'] }] },
      { ...snap(), sessions: [{ ...snap().sessions[0], experiments: { x: 'yes' } }] },
      { ...snap(), sessions: [{ ...snap().sessions[0], shim: 5 }] },
      null,
    ];
    for (const b of bad) {
      fs.mkdirSync(path.dirname(snapshotPath()), { recursive: true });
      fs.writeFileSync(snapshotPath(), JSON.stringify(b));
      expect(loadSnapshot(4242, 1_000_500)).toEqual({ ok: false, reason: 'bad_shape' });
    }
  });
});

describe('browserMatches', () => {
  let child: ChildProcess | undefined;
  afterEach(() => { child?.kill('SIGKILL'); child = undefined; });

  it('procAvailable is true where /proc/self/cmdline reads', () => {
    expect(procAvailable()).toBe(fs.existsSync('/proc/self/cmdline'));
  });

  it.skipIf(!fs.existsSync('/proc/self/cmdline'))('true for a live process with the profile user-data-dir arg, false for another profile or a dead pid', async () => {
    const dir = path.join(home, '.supersurf', 'profiles', 'dev', 'chrome-data');
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', `--user-data-dir=${dir}`], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 100));
    expect(browserMatches(child.pid!, 'dev')).toBe(true);
    expect(browserMatches(child.pid!, 'other')).toBe(false);
    const pid = child.pid!;
    child.kill('SIGKILL');
    await new Promise((r) => child!.once('exit', r));
    expect(browserMatches(pid, 'dev')).toBe(false);
  });
});
