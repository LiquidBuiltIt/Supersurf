/**
 * Daemon restart hand-off (E4). The OLD daemon is the only process that renames
 * `daemon.pid` and `daemon.sock`, so at every instant the pidfile names a live
 * process and the socket accepts (the C5 guard for 4.x servers). The successor
 * binds `daemon.sock.next`, answers `daemon_status` with `takeover:"ready"` and
 * waits for the commit.
 *
 * Phases of the old side: idle, waiting, committing, committed. From
 * `committing` on there is no rollback, no file cleanup and no `server.close()`
 * (it would unlink the successor's socket path).
 *
 * @module handoff
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn as nodeSpawn } from 'child_process';
import { supersurfDir, sockPath, pidPath, isProcessAlive } from 'shared';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const nextSockPath = (): string => sockPath() + '.next';
const handoffDir = (): string => path.join(supersurfDir(), 'daemon');
const entryFile = (): string => path.join(handoffDir(), 'entry');
const spawnsFile = (): string => path.join(handoffDir(), 'spawns.jsonl');
const BAN_MS = 24 * 3600 * 1000;

// ─── entry + spawns.jsonl ────────────────────────────────────

export interface Entry { node: string; main: string; version: string }

const isFile = (p: unknown): boolean => {
  try { return typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isFile(); } catch { return false; }
};

/** The usable `entry`, or null when it is missing, broken or names files that are gone (as the Go shim reads it). */
export function readEntry(): Entry | null {
  try {
    const e = JSON.parse(fs.readFileSync(entryFile(), 'utf8'));
    return typeof e?.version === 'string' && isFile(e.node) && isFile(e.main) ? { node: e.node, main: e.main, version: e.version } : null;
  } catch { return null; }
}

/** tmp + rename, so a reader never sees half an entry. */
export function writeEntry(e: Entry): void {
  fs.mkdirSync(handoffDir(), { recursive: true, mode: 0o700 });
  const tmp = `${entryFile()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 });
  fs.renameSync(tmp, entryFile());
}

/**
 * The shim model is in use when `agents.relay` is on, this daemon accepted a `shim_register` since it
 * started, or was started `--spawned-by=shim`, or is a hand-off successor (`--takeover`: it exists only because the old
 * daemon was in the shim model). Gates the D3 exit and the `restart` hand-off; all four
 * false is a legacy daemon and behaves as before. An `entry` file alone does not count: it outlives the switch.
 */
export function shimModelInUse(o: { relay: boolean; servedShim: boolean; startReason: string; takeover: boolean }): boolean {
  return o.relay || o.servedShim || o.startReason === 'shim' || o.takeover;
}

function splitVersion(v: string): { n: [number, number, number]; pre: string } {
  v = v.replace(/^v/, '');
  let pre = '';
  const i = v.search(/[-+]/);
  if (i >= 0) { pre = v.slice(i + 1); v = v.slice(0, i); }
  const n: [number, number, number] = [0, 0, 0];
  v.split('.', 3).forEach((p, k) => { n[k] = /^[+-]?\d+$/.test(p) ? parseInt(p, 10) : 0; });
  return { n, pre };
}

/** Port of `cmpVersion` in shim/ensure.go: numeric x.y.z, a pre-release suffix sorts below its release. */
export function cmpVersion(a: string, b: string): number {
  const x = splitVersion(a), y = splitVersion(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === '') return 1;
  if (y.pre === '') return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** D3: `entry` names a version newer than this daemon. */
export function upgradePending(ownVersion: string): { from: string; to: string } | null {
  const e = readEntry();
  return e && cmpVersion(e.version, ownVersion) > 0 ? { from: ownVersion, to: e.version } : null;
}

export interface SpawnRecord { pid?: number; entryVersion: string; outcome: string; reason?: string }

/** One line of `spawns.jsonl`; `ts` is epoch milliseconds, the same as the Go shim writes. */
export function appendSpawn(rec: SpawnRecord, now: () => number = Date.now): void {
  fs.mkdirSync(handoffDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(spawnsFile(), JSON.stringify({ ts: now(), ...rec }) + '\n', { mode: 0o600 });
}

/** A `handoff_failed` record of the last 24 h bans a version until a later `ban_cleared` record for it. */
export function isBanned(version: string, now: number = Date.now()): boolean {
  let banned = false;
  let text = '';
  try { text = fs.readFileSync(spawnsFile(), 'utf8'); } catch { return false; }
  for (const line of text.split('\n')) {
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r?.entryVersion !== version) continue;
    if (r.outcome === 'handoff_failed' && now - Number(r.ts) < BAN_MS) banned = true;
    if (r.outcome === 'ban_cleared') banned = false;
  }
  return banned;
}

/** True when a `handoff_failed` record names this pid: the old daemon rolled back and gave up on it. */
export function wasAbandoned(pid: number): boolean {
  let text = '';
  try { text = fs.readFileSync(spawnsFile(), 'utf8'); } catch { return false; }
  for (const line of text.split('\n')) {
    try { const r = JSON.parse(line); if (r?.outcome === 'handoff_failed' && r.pid === pid) return true; } catch {}
  }
  return false;
}

// ─── socket helpers ──────────────────────────────────────────

/** One `daemon_status` round trip on `sock`. Rejects on error or after `timeoutMs`. */
export function queryStatusAt(sock: string, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    let buf = '';
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeoutMs);
    s.on('connect', () => s.write(JSON.stringify({ type: 'daemon_status' }) + '\n'));
    s.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i === -1) return;
      clearTimeout(t);
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
      s.destroy();
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export function connectTo(sock: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    s.once('connect', () => resolve(s));
    s.on('error', reject); // stays on after connect: a later error must not be uncaught
  });
}

/** True when `pid` is gone or a zombie (state Z in /proc: dead, but its parent has not reaped it, so `kill(pid, 0)` still succeeds). Without /proc only `isProcessAlive` applies. */
export function hasExited(pid: number): boolean {
  if (!isProcessAlive(pid)) return true;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
  } catch { return false; }
}

const inoOf = (p: string): number | null => { try { return fs.statSync(p).ino; } catch { return null; } };

// ─── OLD daemon ──────────────────────────────────────────────

export interface UserOwned { profile: string; pid: number }

export interface HandoffOptions {
  version: string;
  port: number;
  debug?: boolean;
  log: (m: string) => void;
  /** SIGTERM the daemon-owned browsers (as `shutdown` does) and return their pids. */
  killOwnedChromium: () => number[];
  userOwned: () => UserOwned[];
  /** After the commit: new pre-handshake lines get `restarting`, shim sockets are told. */
  setRestarting: () => void;
  stopShims: () => Promise<void>;
  /**
   * E9: inside the synchronous commit block, before the pid rename. Writes the resume snapshot, flags the
   * resumable sessions kept, and returns the browser pids step 6 must not kill. A throw rolls the hand-off back.
   */
  prepareResume?: () => number[];
  /** E9: undo `prepareResume` (delete the snapshot, clear the keep flags) on any rollback before the pid rename. */
  cancelResume?: () => void;
  /** End the legacy session sockets WITHOUT closing the listener. */
  endSessions: () => Promise<void>;
  readyMs?: number;
  browserWaitMs?: number;
  pollMs?: number;
  drainMs?: number;
  now?: () => number;
  spawn?: typeof nodeSpawn;
  exit?: (code: number) => void;
  /** How a failed successor is killed (SIGKILL). A test replaces it to keep a late successor alive. */
  kill?: (pid: number) => void;
  /** Crash points, for tests only. */
  fault?: (point: 'after-spawn' | 'after-pid-rename') => void;
  /** This daemon's own `main.js`, the successor when `entry` names nothing. */
  mainPath?: string;
}

export class Handoff {
  state: 'idle' | 'waiting' | 'committing' | 'committed' = 'idle';
  aborted = false;
  private pid: number | null = null;
  constructor(private o: HandoffOptions) {}

  get busy(): boolean { return this.state !== 'idle'; }
  /** True once the commit started: no rollback, no cleanup, no shutdown. */
  get past(): boolean { return this.state === 'committing' || this.state === 'committed'; }

  private killPid(pid: number): void {
    try { (this.o.kill ?? ((p: number) => process.kill(p, 'SIGKILL')))(pid); } catch {}
  }

  /** Crash and abort path: kill the successor and unlink `.next`. Sync. */
  abortSync(): void {
    if (this.pid && isProcessAlive(this.pid)) this.killPid(this.pid);
    try { fs.unlinkSync(nextSockPath()); } catch {}
  }

  /**
   * Run the hand-off. Resolves `failed` after a rollback (the writer got `handoff_failed`)
   * or `committed` once step 6 is done. Any error before the commit rolls back too.
   */
  async run(reply: (m: any) => void): Promise<'committed' | 'failed'> {
    const o = this.o;
    const now = o.now ?? Date.now;
    const pollMs = o.pollMs ?? 25;
    this.state = 'waiting';
    this.aborted = false;
    const NEXT = nextSockPath(), SOCK = sockPath(), PID = pidPath();

    const self: Entry = { node: process.execPath, main: o.mainPath ?? path.join(__dirname, 'main.js'), version: o.version };
    let entry: Entry = self;
    let child: ReturnType<typeof nodeSpawn> | undefined;
    let cc: net.Socket | undefined;
    const logPath = path.join(handoffDir(), 'successor.log');

    const fail = (reason: string): 'failed' => {
      let startupLog = '';
      try { startupLog = fs.readFileSync(logPath, 'utf8').slice(-2000); } catch {}
      cc?.destroy();
      try { o.cancelResume?.(); } catch (e: any) { o.log(`[Handoff] cancelResume failed: ${e?.message ?? e}`); }
      if (child?.pid && isProcessAlive(child.pid)) this.killPid(child.pid);
      try { fs.unlinkSync(NEXT); } catch {}
      try { fs.unlinkSync(PID + '.tmp'); } catch {}
      try {
        appendSpawn({ pid: child?.pid, entryVersion: entry.version, outcome: 'handoff_failed', reason }, now);
        // Restore `entry` to this daemon, only while it still names the failed version (a newer writer wins).
        if (entry.version !== o.version && readEntry()?.version === entry.version) writeEntry(self);
      } catch (e: any) { o.log(`[Handoff] bookkeeping failed: ${e?.message ?? e}`); }
      o.log(`[Handoff] failed: ${reason}`);
      this.state = 'idle';
      this.pid = null;
      reply({ type: 'handoff_failed', reason, startupLog });
      return 'failed';
    };

    try {
      // N2: a double crash can leave a stale .next; listen() would fail on it.
      try { fs.unlinkSync(NEXT); } catch {}

      entry = readEntry() ?? self;
      fs.mkdirSync(handoffDir(), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(logPath, 'w', 0o600);
      const args = [entry.main, '--takeover', String(process.pid), '--port', String(o.port), ...(o.debug ? ['--debug'] : [])];
      child = (o.spawn ?? nodeSpawn)(entry.node, args, { detached: true, stdio: ['ignore', fd, fd], env: process.env });
      fs.closeSync(fd);
      let exited: number | undefined;
      let spawnError = '';
      child.on('exit', (c) => { exited = c ?? -1; });
      child.on('error', (e) => { spawnError = e.message; exited = -1; });
      child.unref();
      if (!child.pid) { await sleep(0); return fail(`could not start the successor: ${spawnError || 'no pid'}`); }
      this.pid = child.pid;
      const cpid = child.pid;
      o.fault?.('after-spawn');

      const deadline = now() + (o.readyMs ?? 10000);
      let ready = false;
      while (!ready) {
        if (this.aborted) return fail('aborted by shutdown signal');
        if (exited !== undefined) return fail(`successor exited (code ${exited})`);
        if (now() > deadline) return fail('no ready before the timeout');
        try {
          const st = await queryStatusAt(NEXT, 500);
          ready = st.takeover === 'ready' && st.pid === cpid;
        } catch {}
        if (!ready) await sleep(pollMs);
      }

      // Open the commit channel BEFORE the renames, so a refused connect still rolls back.
      try { cc = await connectTo(NEXT); } catch { return fail('lost .next after ready'); }
      // A ready seen after the decision is ignored.
      if (this.aborted) return fail('aborted by shutdown signal');
      if (exited !== undefined) return fail(`successor exited (code ${exited})`);
      if (now() > deadline) return fail('ready arrived after the timeout');

      // Commit: synchronous, pid first, then socket. Both files name a live process throughout.
      // The point of no return is the pid rename: a failure before it rolls back like any other.
      // Everything that can throw but the renames is computed before the first one (a throw later has no rollback).
      const commitLine = JSON.stringify({ type: 'takeover_commit', oldpid: process.pid, userOwned: o.userOwned() }) + '\n';
      o.prepareResume?.(); // synchronous from here to setRestarting: no session can register in between
      fs.writeFileSync(PID + '.tmp', String(cpid), { mode: 0o600 });
      fs.renameSync(PID + '.tmp', PID);
      this.state = 'committing';
      o.fault?.('after-pid-rename');
      fs.renameSync(NEXT, SOCK);
      try { appendSpawn({ pid: cpid, entryVersion: entry.version, outcome: 'handoff_committed' }, now); } catch (e: any) { o.log(`[Handoff] commit record failed: ${e?.message ?? e}`); }
      cc.write(commitLine);
      this.state = 'committed';
      o.setRestarting();
      reply({ type: 'handoff_committed', pid: cpid });
    } catch (err: any) {
      if (this.past) {
        // No rollback: the pidfile names the successor. Leave without cleanup so its N5 poll (old pid gone, daemon.pid mine) commits.
        o.log(`[Handoff] error after the commit started: ${err?.message ?? err}; exiting for the successor (N5)`);
        (o.exit ?? process.exit)(1);
        throw err;
      }
      return fail(`error: ${err?.message ?? err}`);
    }

    // Step 6: stop the browsers (N6), the shims and the sessions; exit without close() or cleanup.
    const pids = o.killOwnedChromium();
    const until = now() + (o.browserWaitMs ?? 5000);
    while (pids.some(isProcessAlive) && now() < until) await sleep(pollMs);
    for (const p of pids) if (isProcessAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    try { await o.stopShims(); } catch (err: any) { o.log(`[Handoff] shim stop failed: ${err?.message ?? err}`); }
    try { await o.endSessions(); } catch (err: any) { o.log(`[Handoff] ending sessions failed: ${err?.message ?? err}`); }
    await sleep(o.drainMs ?? 50); // let accepted-but-unread backlog connections get their `restarting` reply
    (o.exit ?? process.exit)(0);
    return 'committed';
  }
}

// ─── SUCCESSOR ───────────────────────────────────────────────

export type CommitResult =
  | { kind: 'commit'; userOwned: UserOwned[]; viaPoll: boolean }
  | { kind: 'leave'; reason: string };

export interface WaitForCommitOptions {
  oldpid: number;
  /** Inode of the `.next` socket this process bound. */
  ownIno: number | null;
  /** Resolves with the old daemon's `takeover_commit` message. */
  commitMsg: Promise<any>;
  log: (m: string) => void;
  pollMs?: number;
}

/**
 * Wait for the commit message, or apply the N5 rules while the old daemon may be dead:
 * old pid gone and `daemon.pid` names this process means it committed and died; old pid
 * gone otherwise, or a rollback seen (`.next` gone, pidfile and socket not mine), means leave.
 */
export function waitForCommit(w: WaitForCommitOptions): Promise<CommitResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: CommitResult) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      resolve(v);
    };
    w.commitMsg.then((m) => finish({ kind: 'commit', userOwned: m?.userOwned ?? [], viaPoll: false }));
    const NEXT = nextSockPath(), SOCK = sockPath();
    const timer = setInterval(() => {
      const oldAlive = !hasExited(w.oldpid);
      let pidIsMe = false;
      try { pidIsMe = parseInt(fs.readFileSync(pidPath(), 'utf8'), 10) === process.pid; } catch {}
      // A late successor binds `.next` after the rollback unlinked it; the failed record is the only sign.
      // shortcut: reads the whole spawns.jsonl each poll, fine while it stays small.
      if (!pidIsMe && wasAbandoned(process.pid)) {
        try { if (inoOf(NEXT) === w.ownIno) fs.unlinkSync(NEXT); } catch {}
        finish({ kind: 'leave', reason: 'the old daemon rolled back and gave up on this process' });
        return;
      }
      if (!oldAlive) {
        if (pidIsMe) {
          w.log('old daemon gone, daemon.pid is mine: treating as commit (N5)');
          try { if (fs.existsSync(NEXT)) fs.renameSync(NEXT, SOCK); } catch {}
          if (inoOf(SOCK) !== w.ownIno) {
            // `.next` is gone and daemon.sock is not this process's listener: nothing can serve. Free the pidfile.
            try { fs.unlinkSync(pidPath()); } catch {}
            finish({ kind: 'leave', reason: 'daemon.sock could not be taken: .next is gone' });
            return;
          }
          finish({ kind: 'commit', userOwned: [], viaPoll: true });
          return;
        }
        try { if (inoOf(NEXT) === w.ownIno) fs.unlinkSync(NEXT); } catch {}
        finish({ kind: 'leave', reason: 'old daemon gone before commit' });
      } else if (!pidIsMe && !fs.existsSync(NEXT) && inoOf(SOCK) !== w.ownIno) {
        finish({ kind: 'leave', reason: '.next was unlinked by the old daemon: rolled back' });
      }
    }, w.pollMs ?? 50);
  });
}

/**
 * Wait for the old daemon to exit; after `limitMs` SIGKILL it (N7), then wait at most `postKillMs`
 * more: a process nobody reaps or one stuck in the kernel must not wedge the successor.
 */
export async function waitOldExit(
  oldpid: number,
  log: (m: string) => void,
  limitMs = 15000,
  o: { postKillMs?: number; exited?: (pid: number) => boolean; kill?: (pid: number) => void } = {},
): Promise<void> {
  const exited = o.exited ?? hasExited;
  const until = Date.now() + limitMs;
  while (!exited(oldpid) && Date.now() < until) await sleep(25);
  if (exited(oldpid)) return;
  log(`old daemon ${oldpid} still alive after ${limitMs} ms: SIGKILL (N7)`);
  try { (o.kill ?? ((p: number) => process.kill(p, 'SIGKILL')))(oldpid); } catch {}
  const postUntil = Date.now() + (o.postKillMs ?? 2000);
  while (!exited(oldpid) && Date.now() < postUntil) await sleep(25);
  if (!exited(oldpid)) log(`old daemon ${oldpid} still not gone after the SIGKILL: going on`);
}

/** R3: bind with backoff (100 ms doubling to 2 s) forever; `setError` names the failure while it lasts. Never exits. */
export async function bindWithBackoff(
  start: () => Promise<void>,
  port: number,
  setError: (e: string | null) => void,
  log: (m: string) => void,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  let delay = 100;
  for (;;) {
    try {
      await start();
      setError(null);
      return;
    } catch (error: any) {
      const msg = `port ${port} busy: ${error?.message ?? error}`;
      setError(msg);
      log(`${msg}; retrying in ${delay}ms`);
      await sleepFn(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }
}
