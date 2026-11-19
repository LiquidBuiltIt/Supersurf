/**
 * Daemon restart hand-off, real processes (E4). Real `daemon/dist/main.js` daemons and real Unix
 * sockets in a throwaway HOME per test, on ports 5611 and up. Never touches ~/.supersurf or port 5555.
 * Needs `npm run build.daemon` first.
 *
 * Timing and fault points are not env seams. A test shapes the successor with the fixture
 * `tests/fixtures/handoff-successor.js` (set as `entry.main`, config in <HOME>/fixture.json) and, where
 * the old daemon needs injected `Handoff` options, runs `tests/fixtures/handoff-old.js`. The one
 * exception is `SUPERSURF_TEST_HANDOFF_FAULT` (main.ts), which crashes the real old daemon at a fixed point.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { isDaemonRunning, sockPath, pidPath, readDaemonPid, isProcessAlive } from 'shared';
import { queryStatusAt, nextSockPath, readEntry } from '../src/handoff';

const MAIN = path.resolve(__dirname, '../dist/main.js');
const OLD_FIXTURE = path.resolve(__dirname, 'fixtures/handoff-old.js');
const SUCCESSOR_FIXTURE = path.resolve(__dirname, 'fixtures/handoff-successor.js');
const PKG_VERSION: string = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number) => isProcessAlive(pid);

let portCounter = 5611 + Math.floor(Math.random() * 40) * 5;
const nextPort = () => portCounter++;

async function waitFor(fn: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** One throwaway HOME and the processes started in it. */
class Rig {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  port = nextPort();
  children: ChildProcess[] = [];
  exits = new Map<number, number | null>();
  extraPids = new Set<number>();
  savedHome = process.env.HOME;
  readonly dir = path.join(this.home, '.supersurf');

  constructor(opts: { idleMs?: number; chromePath?: string } = {}) {
    fs.mkdirSync(path.join(this.dir, 'extension'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'extension', 'manifest.json'), JSON.stringify({ version: '0.0.0' }));
    fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify({
      daemon: { idle_timeout_ms: opts.idleMs ?? 600_000 },
      profiles: { chrome_path: opts.chromePath ?? null },
    }));
    // Stubs https.get so the extension update check is observable and offline.
    fs.writeFileSync(path.join(this.home, 'preload.js'), `
      const https = require('https'); const fs = require('fs'); const { EventEmitter } = require('events');
      https.get = () => {
        fs.appendFileSync(${JSON.stringify(path.join(this.home, 'pulls.log'))},
          process.pid + ' ' + (process.argv.includes('--takeover') ? 'takeover' : 'main') + ' ' + Date.now() + '\\n');
        const e = new EventEmitter(); process.nextTick(() => e.emit('error', new Error('offline stub'))); return e;
      };`);
    process.env.HOME = this.home; // shared/daemon-paths reads HOME at call time
  }

  get sock() { return path.join(this.dir, 'daemon.sock'); }
  get pulls(): { pid: number; who: string; ts: number }[] {
    try {
      return fs.readFileSync(path.join(this.home, 'pulls.log'), 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { const [pid, who, ts] = l.split(' '); return { pid: +pid, who, ts: +ts }; });
    } catch { return []; }
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: this.home, NODE_OPTIONS: `--require ${path.join(this.home, 'preload.js')}`, ...extra };
  }

  /** <HOME>/fixture.json: read by both fixtures. */
  fixture(cfg: Record<string, unknown>): void {
    fs.writeFileSync(path.join(this.home, 'fixture.json'), JSON.stringify(cfg));
  }

  /** Point `entry` at the successor fixture, which loads the real daemon after its configured behaviour. */
  wrap(cfg: Record<string, unknown> = {}, version = '9.9.9-wrap'): void {
    this.fixture({ main: MAIN, ...cfg });
    fs.mkdirSync(path.join(this.dir, 'daemon'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'daemon', 'entry'), JSON.stringify({ node: process.execPath, main: SUCCESSOR_FIXTURE, version }));
  }

  private launch(argv: string[], extra: Record<string, string>): ChildProcess {
    const out = fs.openSync(path.join(this.home, `daemon-${this.children.length}.out`), 'w');
    const c = spawn(process.execPath, argv, { env: this.env(extra), stdio: ['ignore', out, out] });
    this.children.push(c);
    c.on('exit', (code) => this.exits.set(c.pid!, code));
    return c;
  }

  private async untilServing(c: ChildProcess): Promise<number> {
    await waitFor(async () => {
      try { return (await queryStatusAt(this.sock, 300)).pid === c.pid; } catch { return false; }
    }, 10000, 'daemon IPC');
    return c.pid!;
  }

  /** Start the real daemon (not the `start` subcommand, which daemonizes) and wait for IPC. */
  async start(extra: Record<string, string> = {}): Promise<number> {
    return this.untilServing(this.launch([MAIN, '--_daemonized', '--port', String(this.port)], extra));
  }

  /** Start the minimal old-daemon fixture that runs the real `Handoff` with options from fixture.json. */
  async startOld(cfg: Record<string, unknown>): Promise<number> {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(path.join(this.home, 'fixture.json'), 'utf8')); } catch {}
    this.fixture({ ...prev, port: this.port, successorMain: SUCCESSOR_FIXTURE, ...cfg });
    return this.untilServing(this.launch([OLD_FIXTURE], {}));
  }

  restart(timeoutMs = 30000): Promise<any> {
    return this.request(this.sock, { type: 'daemon_restart' }, timeoutMs);
  }

  request(sock: string, msg: object, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(sock);
      let buf = '';
      const t = setTimeout(() => { s.destroy(); reject(new Error('request timeout')); }, timeoutMs);
      s.on('connect', () => s.write(JSON.stringify(msg) + '\n'));
      s.on('data', (d) => {
        buf += d.toString();
        const i = buf.indexOf('\n');
        if (i === -1) return;
        clearTimeout(t); s.destroy();
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
      });
      s.on('close', () => { clearTimeout(t); reject(new Error('closed before reply')); });
      s.on('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  spawns(): any[] {
    try {
      return fs.readFileSync(path.join(this.dir, 'daemon', 'spawns.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  successors(): number[] {
    try { return fs.readFileSync(path.join(this.home, 'successors.log'), 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; }
  }

  pidFile(): number | null { return readDaemonPid(); }
  inode(p: string): number | null { try { return fs.statSync(p).ino; } catch { return null; } }
  daemonLog(): string { try { return fs.readFileSync(path.join(this.dir, 'logs', 'daemon.log'), 'utf8'); } catch { return ''; } }

  /** Register a legacy `session_register` client and return it with its received lines. */
  async legacySession(id: string): Promise<{ socket: net.Socket; lines: string[]; ended: () => boolean }> {
    const socket = net.createConnection(this.sock);
    await new Promise<void>((r, j) => { socket.once('connect', () => r()); socket.once('error', j); });
    const lines: string[] = [];
    let buf = '', ended = false;
    socket.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) !== -1) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    socket.on('close', () => { ended = true; });
    socket.on('error', () => {});
    socket.write(JSON.stringify({ type: 'session_register', sessionId: id }) + '\n');
    await waitFor(() => lines.some((l) => l.includes('session_ack')), 3000, 'session_ack');
    return { socket, lines, ended: () => ended };
  }

  /** Create a profile whose "Chromium" is the fake binary and spawn it. Does not await the extension match. */
  async launchFake(kind: 'connect' | 'launch', name: string): Promise<number> {
    const s = await this.legacySession(`t-${name}`);
    s.socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'profiles.create', params: { name } }) + '\n');
    await waitFor(() => s.lines.some((l) => l.includes('"id":1')), 3000, 'profiles.create');
    s.socket.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: `profiles.${kind}`, params: { profile: name } }) + '\n');
    const log = path.join(this.dir, 'daemon', 'managed-pids.jsonl');
    let pid = 0;
    await waitFor(() => {
      try {
        const l = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).find((e) => e.action === 'spawn' && e.profile === name);
        if (l) pid = l.pid;
      } catch {}
      return pid > 0;
    }, 5000, 'fake chromium spawn');
    this.extraPids.add(pid);
    this.children.push({ kill: () => { s.socket.destroy(); return true; }, pid: 0 } as unknown as ChildProcess);
    return pid;
  }

  /** `ignoreTerm` keeps the old daemon in step 6 for its 5 s browser wait. */
  fakeChrome(ignoreTerm: boolean): string {
    const p = path.join(this.home, 'fake-chrome.sh');
    fs.writeFileSync(p, ignoreTerm ? "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n" : '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 });
    fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify({ profiles: { chrome_path: p } }));
    return p;
  }

  cleanup(): void {
    const pids = new Set<number>(this.extraPids);
    for (const c of this.children) if (c.pid) pids.add(c.pid);
    for (const r of this.spawns()) if (r.pid) pids.add(r.pid);
    for (const p of this.successors()) pids.add(p);
    const p = this.pidFile(); if (p) pids.add(p);
    try {
      for (const l of fs.readFileSync(path.join(this.dir, 'daemon', 'managed-pids.jsonl'), 'utf8').split('\n').filter(Boolean)) pids.add(JSON.parse(l).pid);
    } catch {}
    for (const c of this.children) { try { c.kill('SIGKILL'); } catch {} }
    for (const pid of pids) if (pid > 1 && pid !== process.pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    if (this.savedHome === undefined) delete process.env.HOME; else process.env.HOME = this.savedHome;
    fs.rmSync(this.home, { recursive: true, force: true });
  }
}

/** Probe: the verbatim 4.x predicate plus a `daemon_status` connect, every ~1 ms. `restarting` replies are counted apart from gaps. */
function startProbe(rig: Rig) {
  const r = { iterations: 0, predicateFalse: 0, connectErrors: 0, answered: 0, restarting: 0, pids: new Set<number>() };
  let stop = false;
  const done = (async () => {
    while (!stop) {
      r.iterations++;
      if (!(isDaemonRunning() && fs.existsSync(sockPath()))) r.predicateFalse++;
      try {
        const s = await queryStatusAt(rig.sock, 1000);
        if (s.type === 'daemon_status') { r.answered++; r.pids.add(s.pid); }
        // The designed answer of the old daemon's accept backlog after the commit (plan step 6): the
        // socket accepted and a live process replied, so it is not a gap. A refusal, ENOENT or timeout is.
        else if (s.type === 'restarting') r.restarting++;
        else r.connectErrors++;
      } catch { r.connectErrors++; }
      await sleep(1);
    }
  })();
  return { stop: async () => { stop = true; await done; return r; } };
}

let rig: Rig;
afterEach(() => { rig?.cleanup(); });

/** After a failed hand-off the old daemon is exactly as before and no probe saw a gap. */
async function expectStillOldDaemon(rig: Rig, old: number, sockInoBefore: number | null, p: Awaited<ReturnType<ReturnType<typeof startProbe>['stop']>>) {
  expect(rig.pidFile()).toBe(old);
  expect(alive(old)).toBe(true);
  expect(rig.inode(rig.sock)).toBe(sockInoBefore);
  expect(fs.existsSync(nextSockPath())).toBe(false);
  expect((await queryStatusAt(rig.sock, 1000)).pid).toBe(old);
  expect(p.predicateFalse).toBe(0);
  expect(p.connectErrors).toBe(0);
  expect([...p.pids]).toEqual([old]);
}

describe('hand-off, real processes', () => {
  describe('happy path', () => {
    it('swaps pid and socket, the old daemon exits 0, no probe sees a gap, spawns.jsonl records the commit', async () => {
      rig = new Rig();
      const old = await rig.start();
      const oldSockIno = rig.inode(rig.sock);
      const probe = startProbe(rig);
      await sleep(150);
      const reply = await rig.restart();
      expect(reply.type).toBe('handoff_committed');
      const successor: number = reply.pid;
      await waitFor(() => !alive(old), 10000, 'old exit');
      await sleep(300);
      const r = await probe.stop();
      expect(r.iterations).toBeGreaterThan(100);
      expect(r.predicateFalse).toBe(0);
      expect(r.connectErrors).toBe(0);
      expect(r.answered).toBeGreaterThan(50);
      expect(rig.exits.get(old)).toBe(0);
      expect(successor).not.toBe(old);
      expect(rig.pidFile()).toBe(successor);
      expect(rig.inode(rig.sock)).not.toBe(oldSockIno);
      expect((await queryStatusAt(rig.sock)).pid).toBe(successor);
      expect(fs.existsSync(nextSockPath())).toBe(false);
      const rec = rig.spawns().find((s) => s.outcome === 'handoff_committed');
      expect(rec).toBeTruthy();
      expect(rec.pid).toBe(successor);
      expect(typeof rec.ts).toBe('number');
      expect(rec.ts).toBeGreaterThan(1.6e12); // epoch milliseconds, as the Go shim writes
    }, 40000);

    it('daemon_status on the successor reports pid, protocol 1, shimSessions and takeover committed', async () => {
      rig = new Rig();
      const old = await rig.start();
      const before = await queryStatusAt(rig.sock);
      expect(before).toMatchObject({ pid: old, protocol: 1, shimSessions: 0 });
      expect(before.takeover).toBeUndefined();
      const reply = await rig.restart();
      await waitFor(() => !alive(old), 10000, 'old exit');
      await waitFor(async () => (await queryStatusAt(rig.sock)).takeover === 'committed', 5000, 'successor status');
      expect(await queryStatusAt(rig.sock)).toMatchObject({ pid: reply.pid, protocol: 1, shimSessions: 0, takeover: 'committed' });
    }, 40000);

    it('a legacy session_register client is served by the old daemon before and by the successor after', async () => {
      rig = new Rig();
      const old = await rig.start();
      const before = await rig.legacySession('legacy-1');
      expect(before.lines.some((l) => l.includes('session_ack'))).toBe(true);
      const reply = await rig.restart();
      expect(reply.type).toBe('handoff_committed');
      await waitFor(() => !alive(old), 10000, 'old exit');
      await waitFor(() => before.ended(), 3000, 'old session ended');
      const after = await rig.legacySession('legacy-1');
      expect(after.lines.some((l) => l.includes('session_ack'))).toBe(true);
      expect((await queryStatusAt(rig.sock)).pid).toBe(reply.pid);
      after.socket.destroy();
    }, 40000);

    it("the successor's releaseFiles works after the rename: SIGTERM removes daemon.sock and daemon.pid", async () => {
      rig = new Rig();
      const old = await rig.start();
      const reply = await rig.restart();
      await waitFor(() => !alive(old), 10000, 'old exit');
      await waitFor(async () => (await queryStatusAt(rig.sock)).takeover === 'committed', 5000, 'successor status');
      process.kill(reply.pid, 'SIGTERM');
      await waitFor(() => !alive(reply.pid), 8000, 'successor exit');
      expect(fs.existsSync(rig.sock)).toBe(false);
      expect(fs.existsSync(pidPath())).toBe(false);
    }, 40000);

    it('a leftover daemon.sock.next does not fail the hand-off (N2)', async () => {
      rig = new Rig();
      const old = await rig.start();
      fs.writeFileSync(nextSockPath(), ''); // double crash residue
      const reply = await rig.restart();
      expect(reply.type).toBe('handoff_committed');
      await waitFor(() => !alive(old), 10000, 'old exit');
      expect(rig.pidFile()).toBe(reply.pid);
    }, 40000);

    it('the successor pulls the extension only after the commit (N1)', async () => {
      rig = new Rig();
      rig.wrap({ delayMs: 1200 });
      await rig.start();
      expect(rig.pulls.filter((p) => p.who === 'main')).toHaveLength(1); // the old daemon's own startup check
      const pending = rig.restart();
      await sleep(700); // successor loading, not ready, not committed
      expect(rig.pulls.filter((p) => p.who === 'takeover')).toEqual([]);
      const reply = await pending;
      expect(reply.type).toBe('handoff_committed');
      await waitFor(() => rig.pulls.some((p) => p.who === 'takeover'), 8000, 'post-commit extension check');
      const commit = rig.spawns().find((s) => s.outcome === 'handoff_committed');
      expect(rig.pulls.find((p) => p.who === 'takeover')!.ts).toBeGreaterThanOrEqual(commit.ts);
    }, 40000);
  });

  describe('rollback', () => {
    it('(a) the successor exits before ready: old daemon unchanged, failure recorded, entry restored to self', async () => {
      rig = new Rig();
      rig.wrap({ mode: 'exit-early' });
      const old = await rig.start();
      const ino = rig.inode(rig.sock);
      const probe = startProbe(rig);
      const reply = await rig.restart();
      expect(reply.type).toBe('handoff_failed');
      expect(reply.startupLog).toContain('fixture successor: boot failure');
      await sleep(300);
      await expectStillOldDaemon(rig, old, ino, await probe.stop());
      const failed = rig.spawns().find((s) => s.outcome === 'handoff_failed');
      expect(failed).toMatchObject({ entryVersion: '9.9.9-wrap' });
      expect(typeof failed.ts).toBe('number');
      expect(readEntry()?.version).toBe(PKG_VERSION);
    }, 30000);

    it('(b) the successor never sends ready: failed after readyMs, successor SIGKILLed, old daemon unchanged', async () => {
      rig = new Rig();
      rig.wrap({ mode: 'hang' });
      const old = await rig.startOld({ readyMs: 1500 });
      const ino = rig.inode(rig.sock);
      const probe = startProbe(rig);
      const t0 = Date.now();
      const reply = await rig.restart(8000);
      expect(reply.type).toBe('handoff_failed');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
      await sleep(300);
      await expectStillOldDaemon(rig, old, ino, await probe.stop());
      const failed = rig.spawns().find((s) => s.outcome === 'handoff_failed');
      expect(failed).toBeTruthy();
      await waitFor(() => !alive(failed.pid), 3000, 'successor SIGKILLed');
    }, 30000);

    it('(c) ready arrives after the deadline: the late successor leaves by itself and never touches pid or socket', async () => {
      rig = new Rig();
      rig.wrap({ delayMs: 2200 });
      const old = await rig.startOld({ readyMs: 1000, killNoop: true }); // killNoop keeps the late successor alive
      const ino = rig.inode(rig.sock);
      const probe = startProbe(rig);
      const reply = await rig.restart(8000);
      expect(reply.type).toBe('handoff_failed');
      const failed = rig.spawns().find((s) => s.outcome === 'handoff_failed');
      await sleep(300); // still in its load delay: alive, not dead
      expect(alive(failed.pid)).toBe(true);
      await waitFor(() => !alive(failed.pid), 15000, 'late successor exits by itself');
      await expectStillOldDaemon(rig, old, ino, await probe.stop());
    }, 40000);

    it('does not restore entry over a newer writer', async () => {
      rig = new Rig();
      rig.wrap({ mode: 'exit-after', delayMs: 900 }, '9.9.9-bad');
      await rig.start();
      const pending = rig.restart();
      await sleep(300);
      const entryPath = path.join(rig.dir, 'daemon', 'entry');
      fs.writeFileSync(entryPath, JSON.stringify({ node: process.execPath, main: SUCCESSOR_FIXTURE, version: '9.9.10' }));
      expect((await pending).type).toBe('handoff_failed');
      expect(readEntry()?.version).toBe('9.9.10');
    }, 40000);
  });

  describe('crash between renames (N5)', () => {
    it('the successor takes over when the old daemon dies after the pid rename', async () => {
      rig = new Rig();
      const old = await rig.start({ SUPERSURF_TEST_HANDOFF_FAULT: 'kill-after-pid-rename' });
      const probe = startProbe(rig);
      await rig.restart(5000).catch(() => undefined); // the old daemon kills itself: no reply
      await waitFor(() => !alive(old), 5000, 'old death');
      let succ = 0;
      await waitFor(async () => {
        try { const s = await queryStatusAt(rig.sock, 300); succ = s.pid; return s.pid !== old && s.takeover === 'committed'; } catch { return false; }
      }, 8000, 'successor serving on daemon.sock');
      const r = await probe.stop();
      expect(r.predicateFalse).toBe(0);
      expect(rig.pidFile()).toBe(succ);
      expect(alive(succ)).toBe(true);
      expect(fs.existsSync(nextSockPath())).toBe(false);
    }, 40000);
  });

  describe('bind failure (R3)', () => {
    it('keeps serving IPC, keeps pid and sock, names the busy port, and recovers when it frees', async () => {
      rig = new Rig();
      const busyPort = nextPort();
      rig.wrap({ port: busyPort });
      const old = await rig.start();
      const holder = net.createServer();
      await new Promise<void>((r) => holder.listen(busyPort, '127.0.0.1', () => r()));
      try {
        const reply = await rig.restart(); // the successor binds busyPort, not the old port
        expect(reply.type).toBe('handoff_committed');
        await waitFor(() => !alive(old), 10000, 'old exit');
        await sleep(1500);
        const s = await queryStatusAt(rig.sock);
        expect(s.pid).toBe(reply.pid);
        expect(String(s.bindError)).toContain(String(busyPort));
        expect(alive(reply.pid)).toBe(true);
        expect(rig.pidFile()).toBe(reply.pid);
        expect(fs.existsSync(rig.sock)).toBe(true);
        await new Promise<void>((r) => holder.close(() => r()));
        await waitFor(async () => (await queryStatusAt(rig.sock)).bindError === undefined, 10000, 'bind retry');
      } finally {
        holder.close();
      }
    }, 60000);
  });

  describe('shutdown triggers', () => {
    it('the idle timer never fires during a hand-off (R4)', async () => {
      rig = new Rig({ idleMs: 700 });
      rig.wrap({ delayMs: 2000 });
      const old = await rig.start();
      await sleep(100); // idle timer armed at startup, 700 ms to go
      const reply = await rig.restart();
      expect(reply.type).toBe('handoff_committed');
      expect(rig.pidFile()).toBe(reply.pid);
      expect(old).not.toBe(reply.pid);
      expect(rig.daemonLog()).not.toContain('Idle timeout');
    }, 40000);

    it('SIGTERM before the commit rolls back, then shuts down', async () => {
      rig = new Rig();
      rig.wrap({ delayMs: 4000 });
      const old = await rig.start();
      rig.restart(8000).catch(() => undefined);
      await sleep(700);
      process.kill(old, 'SIGTERM');
      await waitFor(() => !alive(old), 5000, 'old exit');
      const failed = rig.spawns().find((s) => s.outcome === 'handoff_failed');
      expect(failed).toBeTruthy(); // the rollback ran, not just a shutdown
      expect(alive(failed.pid)).toBe(false);
      expect(fs.existsSync(nextSockPath())).toBe(false);
      expect(fs.existsSync(pidPath())).toBe(false);
      expect(fs.existsSync(rig.sock)).toBe(false);
    }, 30000);

    it('SIGTERM after the commit is ignored and the successor keeps serving', async () => {
      rig = new Rig();
      rig.fakeChrome(true);
      const old = await rig.start();
      await rig.launchFake('connect', 'p1'); // daemon-owned, ignores TERM: step 6 waits on it
      const reply = await rig.restart();
      expect(reply.type).toBe('handoff_committed');
      expect(alive(old)).toBe(true);
      process.kill(old, 'SIGTERM');
      await sleep(500);
      expect(alive(old)).toBe(true);
      expect((await queryStatusAt(rig.sock)).pid).toBe(reply.pid);
      expect(rig.pidFile()).toBe(reply.pid);
      await waitFor(() => !alive(old), 15000, 'old exit after browser wait');
      expect((await queryStatusAt(rig.sock)).pid).toBe(reply.pid);
      expect(alive(reply.pid)).toBe(true);
      expect(rig.daemonLog()).toContain('Ignoring SIGTERM');
      expect(rig.daemonLog()).not.toContain('Shutting down (reason=SIGTERM');
    }, 40000);

    it('a second daemon_restart gets handoff_in_progress before the commit, on the old daemon and on the not-yet-whole successor', async () => {
      rig = new Rig();
      rig.fakeChrome(true);
      rig.wrap({ delayMs: 1200 });
      const old = await rig.start();
      await rig.launchFake('connect', 'p1');
      const held = await rig.legacySession('held'); // stays open across the commit
      const first = rig.restart();
      await sleep(500);
      expect((await rig.request(rig.sock, { type: 'daemon_restart' })).type).toBe('handoff_in_progress');
      const reply = await first;
      expect(reply.type).toBe('handoff_committed');
      expect(alive(old)).toBe(true); // step 6 is waiting on the browser
      // New connections now reach the successor, which is not whole until the old daemon is gone.
      expect((await rig.request(rig.sock, { type: 'daemon_restart' })).type).toBe('handoff_in_progress');
      held.socket.destroy();
      expect(rig.spawns().filter((s) => s.outcome === 'handoff_committed')).toHaveLength(1);
    }, 40000);

    it('a crash before the commit kills the successor and unlinks .next', async () => {
      rig = new Rig();
      rig.wrap({ mode: 'hang' });
      const old = await rig.start({ SUPERSURF_TEST_HANDOFF_FAULT: 'crash-after-spawn' });
      rig.restart(5000).catch(() => undefined);
      await waitFor(() => !alive(old), 5000, 'old crash exit');
      const succ = rig.successors()[0];
      expect(succ).toBeGreaterThan(0);
      await waitFor(() => !alive(succ), 3000, 'successor killed');
      expect(fs.existsSync(nextSockPath())).toBe(false);
      expect(fs.existsSync(pidPath())).toBe(false);
    }, 30000);
  });

  describe('step 6 with user-owned browsers', () => {
    it('leaves a user-owned browser alive and the successor adopts it', async () => {
      rig = new Rig();
      rig.fakeChrome(false);
      const old = await rig.start();
      const userPid = await rig.launchFake('launch', 'mine');
      const reply = await rig.restart();
      expect(reply.type).toBe('handoff_committed');
      await waitFor(() => !alive(old), 10000, 'old exit');
      expect(alive(userPid)).toBe(true);
      const s = await rig.legacySession('adopt-check');
      s.socket.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'profiles.list', params: {} }) + '\n');
      await waitFor(() => s.lines.some((l) => l.includes('"id":9')), 3000, 'profiles.list');
      s.socket.destroy();
      const list = JSON.parse(s.lines.find((l) => l.includes('"id":9'))!);
      expect(list.result.profiles.find((p: any) => p.name === 'mine').owner).toBe('user');
    }, 40000);

    it('keeps a live spawned pid unkilled and the pid log untruncated across the hand-off (R2)', async () => {
      rig = new Rig();
      const old = await rig.start();
      const fake = spawn('sleep', ['300']); // stands in for a Chromium the old daemon owns
      rig.children.push(fake);
      const log = path.join(rig.dir, 'daemon', 'managed-pids.jsonl');
      const line = JSON.stringify({ action: 'spawn', profile: 'fake', pid: fake.pid, owner: 'user', ts: new Date().toISOString() });
      fs.writeFileSync(log, line + '\n');
      const reply = await rig.restart();
      expect(reply.type).toBe('handoff_committed');
      await waitFor(() => !alive(old), 10000, 'old exit');
      await sleep(500);
      expect((await queryStatusAt(rig.sock)).pid).toBe(reply.pid);
      expect(alive(fake.pid!)).toBe(true);
      expect(fs.readFileSync(log, 'utf8')).toContain(line);
    }, 40000);
  });
});
