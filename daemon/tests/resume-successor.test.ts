import { describe, it, expect } from 'vitest';
import { runResume, type SuccessorDeps, type ResumeSteps } from '../src/resume-successor';
import type { Snapshot, SnapSession, LoadResult } from '../src/resume';
import type { PidLogEntry } from '../src/profiles/types';

const sess = (id: string, profileId: string | null, over: Partial<SnapSession> = {}): SnapSession => ({
  id, shim: 'shim-1', ownedTabs: [1], createdTabs: [1], attachedTabId: 1, groupId: null, profileId, experiments: {}, ...over,
});
const snap = (sessions: SnapSession[], browsers: Array<{ profile: string; pid: number }>): Snapshot => ({ v: 1, oldpid: 7, ts: 1, sessions, browsers });

interface Rig {
  d: SuccessorDeps;
  s: ResumeSteps;
  calls: string[];
  pids: Map<string, number>;
  owners: Map<string, string>;
  logs: string[];
  pidLog: PidLogEntry[];
  killed: number[];
  alive: Set<number>;
  matching: Set<string>;
  timers: Array<{ fn: () => void; ms: number; stopped: boolean }>;
  parked: SnapSession[];
}

function rig(load: LoadResult, over: { entries?: PidLogEntry[]; viaPoll?: boolean; userOwned?: Array<{ profile: string; pid: number }>; sweepResult?: Array<{ profile: string; pid: number }> } = {}): Rig {
  const calls: string[] = [];
  const pids = new Map<string, number>();
  const owners = new Map<string, string>();
  const logs: string[] = [];
  const pidLog: PidLogEntry[] = [];
  const killed: number[] = [];
  const alive = new Set<number>();
  const matching = new Set<string>();
  const timers: Rig['timers'] = [];
  const parked: SnapSession[] = [];
  const d: SuccessorDeps = {
    oldpid: 7,
    now: () => 5,
    load: () => { calls.push('load'); return load; },
    alive: (pid) => alive.has(pid),
    matches: (pid, profile) => matching.has(`${profile}:${pid}`),
    kill: (pid) => { killed.push(pid); calls.push(`kill:${pid}`); },
    pidLog: () => over.entries ?? [],
    appendPidLog: (e) => { pidLog.push(e); },
    registry: {
      setRunningPid: (n, p, o) => { calls.push(`pin:${n}:${p}:${o}`); pids.set(n, p); owners.set(n, o); },
      clearRunningPid: (n) => { pids.delete(n); owners.delete(n); },
      getRunningPid: (n) => pids.get(n) ?? null,
    },
    every: (fn, ms) => { const t = { fn, ms, stopped: false }; timers.push(t); return { stop: () => { t.stopped = true; } }; },
    log: (m) => logs.push(m),
  };
  const s: ResumeSteps = {
    viaPoll: over.viaPoll ?? false,
    userOwned: over.userOwned ?? [],
    sweep: (exclude) => { calls.push(`sweep:${[...exclude].join(',')}`); pidLog.length = 0; /* the real sweep truncates the log */ return over.sweepResult ?? []; },
    adoptUser: (u) => { calls.push(`user:${u.map((x) => x.pid).join(',')}`); for (const x of u) pids.set(x.profile, x.pid); },
    park: (list) => { calls.push(`park:${list.map((x) => x.id).join(',')}`); parked.push(...list); },
  };
  return { d, s, calls, pids, owners, logs, pidLog, killed, alive, matching, timers, parked };
}

describe('runResume order (D10 S2)', () => {
  it('N5 path: load, adopt browsers, sweep excluding them, user adoption, then restore', () => {
    const r = rig({ ok: true, snap: snap([sess('a', 'dev')], [{ profile: 'dev', pid: 100 }]) }, { viaPoll: true, sweepResult: [{ profile: 'mine', pid: 55 }] });
    r.alive.add(100); r.matching.add('dev:100');
    runResume(r.d, r.s);
    expect(r.calls).toEqual(['load', 'pin:dev:100:daemon', 'sweep:100', 'user:55', 'park:a']);
  });

  it('message path: no sweep, the old daemon passed its user-owned pids', () => {
    const r = rig({ ok: true, snap: snap([sess('a', 'dev')], [{ profile: 'dev', pid: 100 }]) }, { userOwned: [{ profile: 'mine', pid: 55 }] });
    r.alive.add(100); r.matching.add('dev:100');
    runResume(r.d, r.s);
    expect(r.calls).toEqual(['load', 'pin:dev:100:daemon', 'user:55', 'park:a']);
  });

  it('re-appends a spawn line for each adopted browser so a later crash still reaps it', () => {
    const r = rig({ ok: true, snap: snap([sess('a', 'dev')], [{ profile: 'dev', pid: 100 }]) });
    r.alive.add(100); r.matching.add('dev:100');
    runResume(r.d, r.s);
    expect(r.pidLog).toEqual([{ action: 'spawn', profile: 'dev', pid: 100, ts: expect.any(String), owner: 'daemon' }]);
  });

  it('N5 path: the sweep truncates the pid log, so the adopted browser spawn line is written after it', () => {
    const r = rig({ ok: true, snap: snap([sess('a', 'dev')], [{ profile: 'dev', pid: 100 }]) }, { viaPoll: true });
    r.alive.add(100); r.matching.add('dev:100');
    runResume(r.d, r.s);
    expect(r.pidLog).toEqual([{ action: 'spawn', profile: 'dev', pid: 100, ts: expect.any(String), owner: 'daemon' }]);
  });

  it('a missing snapshot is a no-op beyond today: no kill, no park, user adoption still runs', () => {
    const r = rig({ ok: false, reason: 'missing' }, { entries: [{ action: 'spawn', profile: 'dev', pid: 9, ts: 't', owner: 'daemon' }], userOwned: [{ profile: 'mine', pid: 55 }] });
    r.alive.add(9); r.matching.add('dev:9');
    runResume(r.d, r.s);
    expect(r.calls).toEqual(['load', 'user:55']);
    expect(r.killed).toEqual([]);
    expect(r.logs.join('\n')).not.toMatch(/snapshot/i);
  });
});

describe('bad snapshot reaps from the pid log behind the browserMatches guard (row 4)', () => {
  const entries: PidLogEntry[] = [
    { action: 'spawn', profile: 'dev', pid: 100, ts: 't', owner: 'daemon' },
    { action: 'spawn', profile: 'reused', pid: 200, ts: 't', owner: 'daemon' },
    { action: 'spawn', profile: 'mine', pid: 300, ts: 't', owner: 'user' },
    { action: 'spawn', profile: 'done', pid: 400, ts: 't', owner: 'daemon' },
    { action: 'kill', profile: 'done', pid: 400, ts: 't' },
  ];
  for (const reason of ['corrupt', 'wrong_pid', 'stale', 'bad_shape'] as const) {
    it(`${reason}: kills only a logged daemon-owned pid that is alive and matches; parks nothing`, () => {
      const r = rig({ ok: false, reason }, { entries });
      for (const p of [100, 200, 300, 400]) r.alive.add(p);
      r.matching.add('dev:100'); // pid 200 is alive but now some other process
      runResume(r.d, r.s);
      expect(r.killed).toEqual([100]);
      expect(r.pidLog).toEqual([{ action: 'kill', profile: 'dev', pid: 100, ts: expect.any(String) }]);
      expect(r.parked).toEqual([]);
      expect(r.logs.join('\n')).toContain(reason);
    });
  }
});

describe('drop rule', () => {
  it('drops a session whose profile has no live browser; keeps one with a browser and one with no profile', () => {
    const r = rig({ ok: true, snap: snap([sess('live', 'dev'), sess('dead', 'gone'), sess('free', null)], [{ profile: 'dev', pid: 100 }, { profile: 'gone', pid: 101 }]) });
    r.alive.add(100); r.matching.add('dev:100');
    r.alive.add(101); // alive but not the profile's Chromium any more (pid reuse)
    runResume(r.d, r.s);
    expect(r.parked.map((x) => x.id)).toEqual(['live', 'free']);
    expect(r.logs.join('\n')).toMatch(/restored 2.*dropped 1/);
  });

  it('a user-owned browser adopted from the old daemon counts as a live browser', () => {
    const r = rig({ ok: true, snap: snap([sess('u', 'mine')], []) }, { userOwned: [{ profile: 'mine', pid: 55 }] });
    runResume(r.d, r.s);
    expect(r.parked.map((x) => x.id)).toEqual(['u']);
  });

  it('every session dropped: nothing is parked', () => {
    const r = rig({ ok: true, snap: snap([sess('dead', 'gone')], [{ profile: 'gone', pid: 101 }]) });
    runResume(r.d, r.s);
    expect(r.parked).toEqual([]);
    expect(r.calls).not.toContain('park:');
  });
});

describe('onSnapshot seam runs before the adopt check', () => {
  it('a hook that kills the browsers makes the adopt check fail and the session drop', () => {
    const r = rig({ ok: true, snap: snap([sess('a', 'dev')], [{ profile: 'dev', pid: 100 }]) });
    r.alive.add(100); r.matching.add('dev:100');
    runResume({ ...r.d, onSnapshot: (sn) => { for (const b of sn.browsers) r.matching.delete(`${b.profile}:${b.pid}`); } }, r.s);
    expect(r.parked).toEqual([]);
    expect(r.pids.has('dev')).toBe(false);
  });
});

describe('exit watch (risk 12)', () => {
  it('polls every 2 s; on death clears the pid and logs a kill line; stops itself', () => {
    const r = rig({ ok: true, snap: snap([sess('a', 'dev')], [{ profile: 'dev', pid: 100 }]) });
    r.alive.add(100); r.matching.add('dev:100');
    runResume(r.d, r.s);
    expect(r.timers).toHaveLength(1);
    expect(r.timers[0].ms).toBe(2000);

    r.timers[0].fn();
    expect(r.pids.get('dev')).toBe(100);
    r.pidLog.length = 0;

    r.alive.delete(100);
    r.timers[0].fn();
    expect(r.pids.has('dev')).toBe(false);
    expect(r.pidLog).toEqual([{ action: 'kill', profile: 'dev', pid: 100, ts: expect.any(String) }]);
    expect(r.timers[0].stopped).toBe(true);
  });

  it('does not clear a pid that a later spawn replaced', () => {
    const r = rig({ ok: true, snap: snap([sess('a', 'dev')], [{ profile: 'dev', pid: 100 }]) });
    r.alive.add(100); r.matching.add('dev:100');
    runResume(r.d, r.s);
    r.pids.set('dev', 555);
    r.alive.delete(100);
    r.timers[0].fn();
    expect(r.pids.get('dev')).toBe(555);
  });

  it('runResume returns a stop() that stops every watch (shutdown)', () => {
    const r = rig({ ok: true, snap: snap([sess('a', 'dev'), sess('b', 'two')], [{ profile: 'dev', pid: 100 }, { profile: 'two', pid: 101 }]) });
    for (const [p, n] of [['dev', 100], ['two', 101]] as const) { r.alive.add(n); r.matching.add(`${p}:${n}`); }
    const stop = runResume(r.d, r.s);
    expect(r.timers).toHaveLength(2);
    stop();
    expect(r.timers.every((t) => t.stopped)).toBe(true);
  });
});
