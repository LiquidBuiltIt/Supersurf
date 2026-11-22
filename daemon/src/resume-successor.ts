/**
 * E9 resume, successor side (D9 row 2, D10 S2). `runResume` is the whole load, synchronous,
 * with every effect injected: load the snapshot, adopt the browsers that still match, sweep
 * (N5 path only), adopt user-owned browsers, drop sessions with no browser, park the rest.
 * `main.ts` wires the real deps and opens the `IPCServer` resume gate after it returns.
 */

import type { LoadResult, Snapshot, SnapSession } from './resume';
import type { PidLogEntry } from './profiles/types';

export const EXIT_WATCH_MS = 2000;

export interface UserOwnedBrowser { profile: string; pid: number }

export interface SuccessorDeps {
  oldpid: number;
  now: () => number;
  load: () => LoadResult;
  alive: (pid: number) => boolean;
  /** Alive AND the Chromium for this profile (`browserMatches`). */
  matches: (pid: number, profile: string) => boolean;
  kill: (pid: number) => void;
  pidLog: () => PidLogEntry[];
  appendPidLog: (e: PidLogEntry) => void;
  registry: {
    setRunningPid: (profile: string, pid: number, owner: 'daemon' | 'user') => void;
    clearRunningPid: (profile: string) => void;
    getRunningPid: (profile: string) => number | null;
  };
  /** An `unref`'d repeating timer; `main.ts` passes `setInterval`. */
  every: (fn: () => void, ms: number) => { stop: () => void };
  log: (m: string) => void;
  /** Runs right after a good load (dev seam `resume-kill-browser`). */
  onSnapshot?: (snap: Snapshot) => void;
  /** An adopted browser died (re-evaluates the idle timer). */
  onExit?: () => void;
}

export interface ResumeSteps {
  viaPoll: boolean;
  userOwned: UserOwnedBrowser[];
  /** `coldStartSweep`: kill logged orphans except `exclude`, truncate the log, return user-owned live browsers. */
  sweep: (exclude: ReadonlySet<number>) => UserOwnedBrowser[];
  adoptUser: (u: UserOwnedBrowser[]) => void;
  park: (sessions: SnapSession[]) => void;
}

/** Row 4: a bad snapshot reaps daemon-owned logged browsers, but only those that still match. */
function reapFromPidLog(d: SuccessorDeps, entries: PidLogEntry[]): void {
  const live = new Map<number, PidLogEntry>();
  for (const e of entries) {
    if (e.action === 'spawn') live.set(e.pid, e);
    else live.delete(e.pid);
  }
  for (const e of live.values()) {
    if (e.owner === 'user' || !d.alive(e.pid) || !d.matches(e.pid, e.profile)) continue;
    d.kill(e.pid);
    d.appendPidLog({ action: 'kill', profile: e.profile, pid: e.pid, ts: new Date(d.now()).toISOString() });
  }
}

/** Returns `stop()`: clears every exit-watch timer (shutdown). */
export function runResume(d: SuccessorDeps, s: ResumeSteps): () => void {
  const watches: Array<{ stop: () => void }> = [];
  const stop = (): void => { for (const w of watches) w.stop(); };
  const r = d.load();

  if (!r.ok) {
    let exclude: ReadonlySet<number> = new Set();
    if (r.reason !== 'missing') {
      d.log(`[Daemon] Resume snapshot unusable (${r.reason}); reaping logged browsers`);
      const entries = d.pidLog();
      reapFromPidLog(d, entries);
      exclude = new Set(entries.map((e) => e.pid)); // already handled above, behind the guard
    }
    s.adoptUser(s.viaPoll ? s.sweep(exclude) : s.userOwned);
    return stop;
  }

  const snap = r.snap;
  d.onSnapshot?.(snap);

  const liveProfiles = new Set<string>();
  const adoptedPids = new Set<number>();
  for (const b of snap.browsers) {
    if (!d.alive(b.pid) || !d.matches(b.pid, b.profile)) continue;
    d.registry.setRunningPid(b.profile, b.pid, 'daemon');
    liveProfiles.add(b.profile);
    adoptedPids.add(b.pid);
    const watch = d.every(() => {
      if (d.alive(b.pid)) return;
      watch.stop();
      d.appendPidLog({ action: 'kill', profile: b.profile, pid: b.pid, ts: new Date(d.now()).toISOString() });
      if (d.registry.getRunningPid(b.profile) === b.pid) d.registry.clearRunningPid(b.profile);
      d.onExit?.();
    }, EXIT_WATCH_MS);
    watches.push(watch);
  }

  const user = s.viaPoll ? s.sweep(adoptedPids) : s.userOwned;
  s.adoptUser(user);
  // After the sweep: it truncates the pid log, and a later crash must still reap these.
  for (const b of snap.browsers) {
    if (adoptedPids.has(b.pid)) d.appendPidLog({ action: 'spawn', profile: b.profile, pid: b.pid, ts: new Date(d.now()).toISOString(), owner: 'daemon' });
  }
  for (const u of user) liveProfiles.add(u.profile);

  const kept = snap.sessions.filter((x) => x.profileId === null || liveProfiles.has(x.profileId));
  d.log(`[Daemon] Resume: adopted ${adoptedPids.size} browser(s), restored ${kept.length} session(s), dropped ${snap.sessions.length - kept.length}`);
  if (kept.length > 0) s.park(kept);
  return stop;
}
