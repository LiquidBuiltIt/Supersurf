import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as realSpawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { sockPath, pidPath, supersurfDir } from 'shared';
import {
  Handoff, type HandoffOptions, nextSockPath, readEntry, writeEntry, appendSpawn, isBanned,
  wasAbandoned, queryStatusAt, waitForCommit, waitOldExit, bindWithBackoff, hasExited, connectTo,
} from '../src/handoff';

const DEAD_PID = 99999999; // above kernel.pid_max
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let home: string;
let savedHome: string | undefined;
let servers: net.Server[];
let children: ChildProcess[];

const dir = () => path.join(supersurfDir(), 'daemon');
const spawnsOf = (): any[] => {
  try { return fs.readFileSync(path.join(dir(), 'spawns.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const ino = (p: string): number | null => { try { return fs.statSync(p).ino; } catch { return null; } };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-'));
  savedHome = process.env.HOME;
  process.env.HOME = home; // shared/daemon-paths reads HOME at call time
  fs.mkdirSync(supersurfDir(), { recursive: true });
  servers = [];
  children = [];
});
afterEach(() => {
  for (const s of servers) s.close();
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** A listener standing in for the successor on `.next`: answers `daemon_status`, records every other line. */
function listen(sock: string, pid: number, ready = true, lines: any[] = []): Promise<{ lines: any[]; server: net.Server }> {
  const server = net.createServer((c) => {
    let buf = '';
    c.on('error', () => {});
    c.on('data', (d) => {
      buf += d.toString();
      for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.type === 'daemon_status') c.write(JSON.stringify({ type: 'daemon_status', pid, ...(ready ? { takeover: 'ready' } : {}) }) + '\n');
        else lines.push(m);
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(sock, () => resolve({ lines, server })));
}

describe('entry and spawns.jsonl', () => {
  const entry = () => {
    const node = path.join(home, 'node'), main = path.join(home, 'main.js');
    fs.writeFileSync(node, ''); fs.writeFileSync(main, '');
    return { node, main, version: '5.0.1' };
  };

  it('readEntry returns null when the file is missing, broken, or names files that are gone', () => {
    expect(readEntry()).toBeNull();
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), 'entry'), '{not json');
    expect(readEntry()).toBeNull();
    fs.writeFileSync(path.join(dir(), 'entry'), JSON.stringify({ node: '/no/such/node', main: '/no/such/main.js', version: '1.0.0' }));
    expect(readEntry()).toBeNull();
    fs.writeFileSync(path.join(dir(), 'entry'), JSON.stringify({ node: 'relative', main: 'relative', version: '1.0.0' }));
    expect(readEntry()).toBeNull();
  });

  it('writeEntry round-trips mode 0600 and leaves no tmp file', () => {
    const e = entry();
    writeEntry(e);
    expect(readEntry()).toEqual(e);
    expect(fs.statSync(path.join(dir(), 'entry')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir()).filter((f) => f.includes('tmp'))).toEqual([]);
  });

  it('appendSpawn writes an epoch-millisecond ts, as the Go shim does', () => {
    appendSpawn({ entryVersion: '1.0.0', outcome: 'handoff_committed', pid: 7 });
    appendSpawn({ entryVersion: '1.0.0', outcome: 'x' }, () => 1234);
    const [a, b] = spawnsOf();
    expect(typeof a.ts).toBe('number');
    expect(a.ts).toBeGreaterThan(1.6e12);
    expect(a).toMatchObject({ entryVersion: '1.0.0', outcome: 'handoff_committed', pid: 7 });
    expect(b.ts).toBe(1234);
  });

  it('isBanned: a handoff_failed within 24 h bans that version until a later ban_cleared', () => {
    const now = 10 * 24 * 3600 * 1000;
    appendSpawn({ entryVersion: '9.9.9', outcome: 'handoff_failed' }, () => now - 1000);
    expect(isBanned('9.9.9', now)).toBe(true);
    expect(isBanned('9.9.8', now)).toBe(false);
    appendSpawn({ entryVersion: '9.9.9', outcome: 'ban_cleared' }, () => now - 500);
    expect(isBanned('9.9.9', now)).toBe(false);
  });

  it('isBanned: a failure older than 24 h does not ban; no file means no ban', () => {
    expect(isBanned('1.0.0')).toBe(false);
    const now = 10 * 24 * 3600 * 1000;
    appendSpawn({ entryVersion: '1.0.0', outcome: 'handoff_failed' }, () => now - 25 * 3600 * 1000);
    expect(isBanned('1.0.0', now)).toBe(false);
  });

  it('wasAbandoned finds a handoff_failed record for this pid only', () => {
    expect(wasAbandoned(42)).toBe(false);
    appendSpawn({ pid: 41, entryVersion: '1', outcome: 'handoff_failed' });
    appendSpawn({ pid: 42, entryVersion: '1', outcome: 'handoff_committed' });
    expect(wasAbandoned(42)).toBe(false);
    appendSpawn({ pid: 42, entryVersion: '1', outcome: 'handoff_failed' });
    expect(wasAbandoned(42)).toBe(true);
  });
});

describe('queryStatusAt', () => {
  it('resolves with the reply, rejects on a silent listener and on a missing socket', async () => {
    const { server } = await listen(path.join(home, 'q.sock'), 5);
    expect((await queryStatusAt(path.join(home, 'q.sock'))).pid).toBe(5);
    server.close();
    const silent = net.createServer(() => {});
    servers.push(silent);
    await new Promise<void>((r) => silent.listen(path.join(home, 's.sock'), () => r()));
    await expect(queryStatusAt(path.join(home, 's.sock'), 100)).rejects.toThrow('timeout');
    await expect(queryStatusAt(path.join(home, 'none.sock'), 100)).rejects.toThrow();
  });
});

describe('Handoff.run (old side, injected options)', () => {
  const FAKE = process.pid; // a live pid standing in for the successor; `kill` is injected so it is never signalled
  let order: string[];
  let kills: number[];
  let spawnArgs: any[];
  let atSpawn: { nextExists?: boolean };
  // The successor's listener is bound inside the fake spawn: `run` unlinks a stale .next before it spawns (N2).
  let succMode: 'ready' | 'notready' | 'none';
  let succLines: any[];

  /** A spawn that returns a fake child. `onSpawn` runs inside it (after `successor.log` was truncated). */
  function fakeSpawn(o: { exit?: number; noPid?: boolean; throws?: boolean; onSpawn?: () => void } = {}): typeof realSpawn {
    return ((cmd: string, args: string[]) => {
      spawnArgs.push([cmd, args]);
      atSpawn = { nextExists: fs.existsSync(nextSockPath()) };
      if (o.throws) throw new Error('spawn boom');
      o.onSpawn?.();
      if (succMode !== 'none') void listen(nextSockPath(), FAKE, succMode === 'ready', succLines);
      const ee = new EventEmitter() as any;
      ee.pid = o.noPid ? undefined : FAKE;
      ee.unref = () => {};
      if (o.exit !== undefined) setImmediate(() => ee.emit('exit', o.exit));
      return ee;
    }) as unknown as typeof realSpawn;
  }

  function opts(over: Partial<HandoffOptions> = {}): HandoffOptions {
    return {
      version: '1.0.0', port: 6001, log: () => {},
      killOwnedChromium: () => { order.push('killChromium'); return []; },
      userOwned: () => [{ profile: 'mine', pid: 4242 }],
      setRestarting: () => { order.push('setRestarting'); },
      stopShims: async () => { order.push('stopShims'); },
      endSessions: async () => { order.push('endSessions'); },
      readyMs: 400, pollMs: 5, drainMs: 1, browserWaitMs: 50,
      kill: (p) => { kills.push(p); },
      exit: (c) => { order.push(`exit${c}`); },
      spawn: fakeSpawn(),
      mainPath: '/self/main.js',
      ...over,
    };
  }

  beforeEach(() => {
    order = []; kills = []; spawnArgs = []; atSpawn = {}; succMode = 'ready'; succLines = [];
    fs.writeFileSync(pidPath(), String(process.pid));
    fs.writeFileSync(sockPath(), 'old');
  });

  it('commits in order: pid first, then socket, then the record, the message, the reply, then step 6', async () => {
    const oldSockIno = ino(sockPath());
    const seen: any = {};
    const replies: any[] = [];
    const h = new Handoff(opts({
      fault: (p) => {
        if (p !== 'after-pid-rename') return;
        seen.state = h.state;
        seen.pid = fs.readFileSync(pidPath(), 'utf8');
        seen.sockIsOld = ino(sockPath()) === oldSockIno;
        seen.nextStillThere = fs.existsSync(nextSockPath());
        seen.nextIno = ino(nextSockPath());
      },
    }));
    const r = await h.run((m) => replies.push(m));
    expect(r).toBe('committed');
    expect(seen).toMatchObject({ state: 'committing', pid: String(FAKE), sockIsOld: true, nextStillThere: true });
    expect(fs.readFileSync(pidPath(), 'utf8')).toBe(String(FAKE));
    expect(ino(sockPath())).toBe(seen.nextIno);
    expect(fs.existsSync(nextSockPath())).toBe(false);
    expect(replies).toEqual([{ type: 'handoff_committed', pid: FAKE }]);
    expect(spawnsOf().filter((s) => s.outcome === 'handoff_committed')).toMatchObject([{ pid: FAKE, entryVersion: '1.0.0' }]);
    expect(typeof spawnsOf()[0].ts).toBe('number');
    await sleep(30);
    expect(succLines).toEqual([{ type: 'takeover_commit', oldpid: process.pid, userOwned: [{ profile: 'mine', pid: 4242 }] }]);
    expect(order).toEqual(['setRestarting', 'killChromium', 'stopShims', 'endSessions', 'exit0']);
    expect(h.state).toBe('committed');
    expect(h.past).toBe(true);
    expect(kills).toEqual([]);
  });

  it('spawns the entry (or this daemon) with --takeover <pid> --port and --debug', async () => {
    await new Handoff(opts({ debug: true })).run(() => {});
    expect(spawnArgs[0][0]).toBe(process.execPath);
    expect(spawnArgs[0][1]).toEqual(['/self/main.js', '--takeover', String(process.pid), '--port', '6001', '--debug']);
  });

  it('uses the node and main named by a usable entry', async () => {
    const node = path.join(home, 'n'), main = path.join(home, 'm.js');
    fs.writeFileSync(node, ''); fs.writeFileSync(main, '');
    writeEntry({ node, main, version: '2.0.0' });
    const h = new Handoff(opts());
    await h.run(() => {});
    expect(spawnArgs[0][0]).toBe(node);
    expect(spawnArgs[0][1][0]).toBe(main);
    expect(spawnsOf().find((s) => s.outcome === 'handoff_committed').entryVersion).toBe('2.0.0');
  });

  it('in a dev clone ignores a leftover entry and hands off to its own main.js', async () => {
    const node = path.join(home, 'n'), main = path.join(home, 'm.js');
    fs.writeFileSync(node, ''); fs.writeFileSync(main, '');
    writeEntry({ node, main, version: '2.0.0' });
    const saved = process.env.SUPERSURF_DEV_ENVIRONMENT;
    process.env.SUPERSURF_DEV_ENVIRONMENT = '/some/clone';
    try {
      await new Handoff(opts()).run(() => {});
    } finally {
      if (saved === undefined) delete process.env.SUPERSURF_DEV_ENVIRONMENT; else process.env.SUPERSURF_DEV_ENVIRONMENT = saved;
    }
    expect(spawnArgs[0][0]).toBe(process.execPath);
    expect(spawnArgs[0][1][0]).toBe('/self/main.js');
  });

  it('unlinks a stale daemon.sock.next before it spawns (N2)', async () => {
    fs.writeFileSync(nextSockPath(), '');
    const h = new Handoff(opts({ spawn: fakeSpawn({ exit: 1 }) }));
    await h.run(() => {});
    expect(atSpawn.nextExists).toBe(false);
  });

  it('rolls back when the successor exits: kills it, unlinks .next, records, replies with the startup log', async () => {
    succMode = 'notready';
    const logPath = path.join(dir(), 'successor.log');
    const replies: any[] = [];
    const h = new Handoff(opts({ spawn: fakeSpawn({ exit: 3, onSpawn: () => fs.writeFileSync(logPath, 'boom: cannot start') }) }));
    expect(await h.run((m) => replies.push(m))).toBe('failed');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: 'handoff_failed', startupLog: 'boom: cannot start' });
    expect(replies[0].reason).toContain('exited (code 3)');
    expect(kills).toEqual([FAKE]);
    expect(fs.existsSync(nextSockPath())).toBe(false);
    expect(fs.readFileSync(pidPath(), 'utf8')).toBe(String(process.pid));
    expect(fs.readFileSync(sockPath(), 'utf8')).toBe('old');
    expect(spawnsOf()).toMatchObject([{ pid: FAKE, outcome: 'handoff_failed' }]);
    expect(h.state).toBe('idle');
    expect(h.busy).toBe(false);
    expect(order).toEqual([]);
  });

  it('rolls back when there is no ready before readyMs', async () => {
    succMode = 'none';
    const replies: any[] = [];
    const h = new Handoff(opts({ readyMs: 120 }));
    expect(await h.run((m) => replies.push(m))).toBe('failed');
    expect(replies[0].reason).toContain('no ready');
    expect(kills).toEqual([FAKE]);
    expect(h.state).toBe('idle');
  });

  it('rolls back on a ready that arrives after the deadline', async () => {
    let calls = 0;
    const replies: any[] = [];
    const h = new Handoff(opts({ now: () => (++calls <= 2 ? 0 : 5000) }));
    expect(await h.run((m) => replies.push(m))).toBe('failed');
    expect(replies[0].reason).toContain('after the timeout');
    expect(fs.readFileSync(pidPath(), 'utf8')).toBe(String(process.pid));
    expect(fs.existsSync(nextSockPath())).toBe(false);
  });

  it('rolls back when the signal handler sets aborted', async () => {
    let h!: Handoff;
    h = new Handoff(opts({ spawn: fakeSpawn({ onSpawn: () => { h.aborted = true; } }) }));
    const replies: any[] = [];
    expect(await h.run((m) => replies.push(m))).toBe('failed');
    expect(replies[0].reason).toContain('aborted');
    expect(fs.readFileSync(pidPath(), 'utf8')).toBe(String(process.pid));
  });

  it('rolls back on an exception before the commit (the spawn throws)', async () => {
    const replies: any[] = [];
    const h = new Handoff(opts({ spawn: fakeSpawn({ throws: true }) }));
    expect(await h.run((m) => replies.push(m))).toBe('failed');
    expect(replies[0].reason).toContain('spawn boom');
    expect(h.state).toBe('idle');
  });

  it('a userOwned() that throws rolls back: it is read before the pid rename', async () => {
    const replies: any[] = [];
    const h = new Handoff(opts({ userOwned: () => { throw new Error('registry boom'); } }));
    expect(await h.run((m) => replies.push(m))).toBe('failed');
    expect(replies[0]).toMatchObject({ type: 'handoff_failed' });
    expect(replies[0].reason).toContain('registry boom');
    expect(fs.readFileSync(pidPath(), 'utf8')).toBe(String(process.pid));
    expect(order).not.toContain('setRestarting');
  });

  it('a failing handoff_committed record after the pid rename does not stop the commit', async () => {
    const replies: any[] = [];
    const h = new Handoff(opts({
      fault: (p) => { if (p === 'after-pid-rename') fs.mkdirSync(path.join(dir(), 'spawns.jsonl')); }, // appendFile then fails with EISDIR
    }));
    expect(await h.run((m) => replies.push(m))).toBe('committed');
    expect(replies).toEqual([{ type: 'handoff_committed', pid: FAKE }]);
    await sleep(30);
    expect(succLines).toHaveLength(1);
    expect(order).toEqual(['setRestarting', 'killChromium', 'stopShims', 'endSessions', 'exit0']);
  });

  it('a throw after the pid rename exits 1 in place of staying in committing (S2b)', async () => {
    const h = new Handoff(opts({ fault: (p) => { if (p === 'after-pid-rename') fs.unlinkSync(nextSockPath()); } })); // the .next rename gets ENOENT
    await expect(h.run(() => {})).rejects.toThrow();
    expect(h.state).toBe('committing');
    expect(order).toEqual(['exit1']);
    expect(fs.readFileSync(pidPath(), 'utf8')).toBe(String(FAKE)); // the pidfile stays the successor's
  });

  it('step 6 still exits 0 when endSessions rejects (N1)', async () => {
    const h = new Handoff(opts({ endSessions: async () => { throw new Error('end boom'); } }));
    expect(await h.run(() => {})).toBe('committed');
    expect(order).toContain('exit0');
  });

  it('rolls back when the spawn yields no pid', async () => {
    const replies: any[] = [];
    const h = new Handoff(opts({ spawn: fakeSpawn({ noPid: true }) }));
    expect(await h.run((m) => replies.push(m))).toBe('failed');
    expect(replies[0].reason).toContain('could not start the successor');
  });

  it('is busy but not past while it waits for ready, and past from the commit on', async () => {
    const seen: any = {};
    let h!: Handoff;
    h = new Handoff(opts({
      fault: (p) => {
        if (p === 'after-spawn') seen.waiting = { busy: h.busy, past: h.past, state: h.state };
        if (p === 'after-pid-rename') seen.committing = { busy: h.busy, past: h.past, state: h.state };
      },
    }));
    await h.run(() => {});
    expect(seen).toEqual({
      waiting: { busy: true, past: false, state: 'waiting' },
      committing: { busy: true, past: true, state: 'committing' },
    });
  });

  describe('entry restore on failure', () => {
    const mkEntry = (version: string) => {
      const node = path.join(home, 'n'), main = path.join(home, 'm.js');
      fs.writeFileSync(node, ''); fs.writeFileSync(main, '');
      return { node, main, version };
    };

    it('restores entry to this daemon while it still names the failed version', async () => {
      writeEntry(mkEntry('2.0.0'));
      await new Handoff(opts({ spawn: fakeSpawn({ exit: 1 }) })).run(() => {});
      expect(readEntry()).toBeNull(); // self.main is /self/main.js, not a real file: the restored entry is unusable here
      expect(JSON.parse(fs.readFileSync(path.join(dir(), 'entry'), 'utf8'))).toEqual({ node: process.execPath, main: '/self/main.js', version: '1.0.0' });
    });

    it('does not restore over a newer entry written while the hand-off ran', async () => {
      writeEntry(mkEntry('2.0.0'));
      succMode = 'none';
      const h = new Handoff(opts({ spawn: fakeSpawn({ onSpawn: () => setTimeout(() => writeEntry(mkEntry('3.0.0')), 10) }), readyMs: 100 }));
      await h.run(() => {});
      expect(readEntry()?.version).toBe('3.0.0');
    });

    it('does not write when the failed version is this daemon own version', async () => {
      writeEntry(mkEntry('1.0.0'));
      const before = fs.readFileSync(path.join(dir(), 'entry'), 'utf8');
      await new Handoff(opts({ spawn: fakeSpawn({ exit: 1 }) })).run(() => {});
      expect(fs.readFileSync(path.join(dir(), 'entry'), 'utf8')).toBe(before);
    });

    it('does not create an entry when none existed', async () => {
      await new Handoff(opts({ spawn: fakeSpawn({ exit: 1 }) })).run(() => {});
      expect(fs.existsSync(path.join(dir(), 'entry'))).toBe(false);
    });
  });

  it('abortSync kills the successor and unlinks .next without a reply', async () => {
    succMode = 'notready';
    let h!: Handoff;
    h = new Handoff(opts({ fault: (p) => { if (p === 'after-spawn') h.abortSync(); }, readyMs: 100 }));
    await h.run(() => {});
    expect(kills.length).toBeGreaterThan(0);
    expect(fs.existsSync(nextSockPath())).toBe(false);
  });

  it('rethrows an error after the commit started and writes no handoff_failed', async () => {
    const h = new Handoff(opts({ setRestarting: () => { throw new Error('late boom'); } }));
    await expect(h.run(() => {})).rejects.toThrow('late boom');
    expect(spawnsOf().map((s) => s.outcome)).toEqual(['handoff_committed']);
    expect(fs.readFileSync(pidPath(), 'utf8')).toBe(String(FAKE));
  });

  it('step 6 SIGKILLs a daemon-owned browser that ignores SIGTERM after browserWaitMs', async () => {
    const chrome = realSpawn('sh', ['-c', "trap '' TERM; while :; do sleep 1; done"], { stdio: 'ignore' });
    children.push(chrome);
    await sleep(100);
    const h = new Handoff(opts({ killOwnedChromium: () => { order.push('killChromium'); return [chrome.pid!]; }, browserWaitMs: 150 }));
    await h.run(() => {});
    await sleep(100);
    expect(chrome.exitCode !== null || chrome.signalCode !== null).toBe(true);
    expect(order[order.length - 1]).toBe('exit0');
  });
});

describe('waitForCommit (successor side)', () => {
  const NEXT = () => nextSockPath();
  const race = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => 'still waiting' as const)]);

  function setup(): { ownIno: number } {
    fs.writeFileSync(NEXT(), 'mine');
    return { ownIno: ino(NEXT())! };
  }

  it('commits on the takeover_commit message and carries the user-owned list', async () => {
    const { ownIno } = setup();
    fs.writeFileSync(pidPath(), String(process.pid));
    const r = await waitForCommit({
      oldpid: process.ppid, ownIno, log: () => {}, pollMs: 5,
      commitMsg: Promise.resolve({ type: 'takeover_commit', userOwned: [{ profile: 'a', pid: 9 }] }),
    });
    expect(r).toEqual({ kind: 'commit', userOwned: [{ profile: 'a', pid: 9 }], viaPoll: false });
  });

  it('keeps waiting while the old daemon lives and .next is still there', async () => {
    const { ownIno } = setup();
    fs.writeFileSync(pidPath(), String(process.ppid));
    expect(await race(waitForCommit({ oldpid: process.ppid, ownIno, log: () => {}, pollMs: 5, commitMsg: new Promise(() => {}) }), 150)).toBe('still waiting');
  });

  it('old pid gone and daemon.pid names this process: commits by poll and renames .next over daemon.sock (N5)', async () => {
    const { ownIno } = setup();
    fs.writeFileSync(pidPath(), String(process.pid));
    const r = await waitForCommit({ oldpid: DEAD_PID, ownIno, log: () => {}, pollMs: 5, commitMsg: new Promise(() => {}) });
    expect(r).toEqual({ kind: 'commit', userOwned: [], viaPoll: true });
    expect(fs.existsSync(NEXT())).toBe(false);
    expect(ino(sockPath())).toBe(ownIno);
  });

  it('old pid gone, daemon.pid mine, but .next is gone and daemon.sock is not mine: leaves and removes its pidfile (S2b)', async () => {
    const { ownIno } = setup();
    fs.unlinkSync(NEXT());
    fs.writeFileSync(pidPath(), String(process.pid));
    const r = await waitForCommit({ oldpid: DEAD_PID, ownIno, log: () => {}, pollMs: 5, commitMsg: new Promise(() => {}) });
    expect(r.kind).toBe('leave');
    expect(fs.existsSync(pidPath())).toBe(false); // nothing serves: the next ensure starts clean
  });

  it('old pid gone, daemon.pid mine, .next gone but daemon.sock is mine: commits (the old daemon renamed, then died)', async () => {
    const { ownIno } = setup();
    fs.renameSync(NEXT(), sockPath());
    fs.writeFileSync(pidPath(), String(process.pid));
    const r = await waitForCommit({ oldpid: DEAD_PID, ownIno, log: () => {}, pollMs: 5, commitMsg: new Promise(() => {}) });
    expect(r).toEqual({ kind: 'commit', userOwned: [], viaPoll: true });
  });

  it('old pid gone and daemon.pid not this process: leaves and unlinks its own .next', async () => {
    const { ownIno } = setup();
    fs.writeFileSync(pidPath(), String(process.ppid));
    const r = await waitForCommit({ oldpid: DEAD_PID, ownIno, log: () => {}, pollMs: 5, commitMsg: new Promise(() => {}) });
    expect(r.kind).toBe('leave');
    expect(fs.existsSync(NEXT())).toBe(false);
    expect(fs.readFileSync(pidPath(), 'utf8')).toBe(String(process.ppid));
  });

  it('old pid gone: does not unlink a .next that is another process', async () => {
    setup();
    fs.writeFileSync(pidPath(), String(process.ppid));
    const r = await waitForCommit({ oldpid: DEAD_PID, ownIno: 1, log: () => {}, pollMs: 5, commitMsg: new Promise(() => {}) });
    expect(r.kind).toBe('leave');
    expect(fs.existsSync(NEXT())).toBe(true);
  });

  it('old alive, .next gone, daemon.sock not mine, pidfile not mine: rolled back, leaves', async () => {
    const { ownIno } = setup();
    fs.writeFileSync(pidPath(), String(process.ppid));
    fs.writeFileSync(sockPath(), 'old');
    fs.unlinkSync(NEXT());
    const r = await waitForCommit({ oldpid: process.ppid, ownIno, log: () => {}, pollMs: 5, commitMsg: new Promise(() => {}) });
    expect(r).toMatchObject({ kind: 'leave' });
  });

  it('leaves when spawns.jsonl records that the old daemon gave up on this pid (late successor)', async () => {
    const { ownIno } = setup();
    fs.writeFileSync(pidPath(), String(process.ppid));
    appendSpawn({ pid: process.pid, entryVersion: '1.0.0', outcome: 'handoff_failed' });
    const r = await waitForCommit({ oldpid: process.ppid, ownIno, log: () => {}, pollMs: 5, commitMsg: new Promise(() => {}) });
    expect(r.kind).toBe('leave');
    expect(fs.existsSync(NEXT())).toBe(false);
  });
});

describe('waitOldExit', () => {
  it('returns at once for a dead pid', async () => {
    const t = Date.now();
    await waitOldExit(DEAD_PID, () => {}, 5000);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('SIGKILLs an old daemon still alive after the limit (N7)', async () => {
    const c = realSpawn('sh', ['-c', "trap '' TERM; while :; do sleep 1; done"], { stdio: 'ignore' });
    children.push(c);
    await sleep(100);
    const logs: string[] = [];
    await waitOldExit(c.pid!, (m) => logs.push(m), 150);
    expect(logs.join()).toContain('SIGKILL');
    await sleep(50);
    expect(c.exitCode !== null || c.signalCode !== null).toBe(true);
  });
});

describe('a zombie old daemon counts as gone (S1)', () => {
  /** A python parent that never reaps: its child becomes state Z once it exits. Node would reap it. */
  async function zombie(): Promise<number> {
    const c = realSpawn('python3', ['-I', '-c', "import subprocess,time;p=subprocess.Popen(['sleep','0.1']);print(p.pid,flush=True);time.sleep(60)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(c);
    const pid = await new Promise<number>((r) => c.stdout!.once('data', (d) => r(parseInt(String(d), 10))));
    await sleep(400);
    return pid;
  }

  it('hasExited is true for a zombie, false for a live process', async () => {
    const z = await zombie();
    expect(hasExited(z)).toBe(true);
    expect(hasExited(process.pid)).toBe(false);
    expect(hasExited(DEAD_PID)).toBe(true);
  });

  it('waitOldExit returns for a zombie instead of looping after the SIGKILL', async () => {
    const z = await zombie();
    const t = Date.now();
    await waitOldExit(z, () => {}, 100);
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it('waitOldExit gives up after the post-SIGKILL bound when the pid never dies', async () => {
    const t = Date.now();
    const logs: string[] = [];
    await waitOldExit(process.pid + 1, (m) => logs.push(m), 50, { postKillMs: 150, exited: () => false, kill: () => {} });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(logs.join()).toContain('SIGKILL');
  });

  it('waitForCommit treats a zombie old pid with daemon.pid naming this process as a commit (N5)', async () => {
    const z = await zombie();
    fs.writeFileSync(pidPath(), String(process.pid));
    const r = await waitForCommit({ oldpid: z, ownIno: null, log: () => {}, pollMs: 5, commitMsg: new Promise(() => {}) });
    expect(r).toMatchObject({ kind: 'commit', viaPoll: true });
  });
});

describe('connectTo (the commit channel)', () => {
  it('keeps an error listener after connect: a second socket error is not uncaught', async () => {
    const sock = path.join(home, 's.sock');
    const srv = net.createServer(() => {});
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(sock, () => r()));
    const s = await connectTo(sock);
    expect(() => { s.emit('error', new Error('one')); s.emit('error', new Error('two')); }).not.toThrow();
    s.destroy();
  });
});

describe('bindWithBackoff (R3)', () => {
  it('retries forever with 100 ms doubling to a 2 s cap, names the port while busy, clears the error on success', async () => {
    let fails = 7;
    const delays: number[] = [];
    const errors: (string | null)[] = [];
    await bindWithBackoff(
      async () => { if (fails-- > 0) throw new Error('EADDRINUSE'); },
      6001, (e) => errors.push(e), () => {}, async (ms) => { delays.push(ms); },
    );
    expect(delays).toEqual([100, 200, 400, 800, 1600, 2000, 2000]);
    expect(errors[0]).toContain('6001');
    expect(errors[0]).toContain('EADDRINUSE');
    expect(errors[errors.length - 1]).toBeNull();
  });

  it('succeeds first time without an error or a sleep', async () => {
    const errors: (string | null)[] = [];
    await bindWithBackoff(async () => {}, 6001, (e) => errors.push(e), () => {}, async () => { throw new Error('slept'); });
    expect(errors).toEqual([null]);
  });
});
