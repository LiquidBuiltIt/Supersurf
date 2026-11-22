/**
 * E9 resume: the hand-off snapshot. Ids and pids only, mode 0600.
 *
 * Old daemon: `writeSnapshot` inside the synchronous commit block. Successor:
 * `loadSnapshot` (always deletes the file), then `browserMatches` per browser pid.
 */

import fs from 'fs';
import path from 'path';
import { supersurfDir } from 'shared';

export const snapshotPath = (): string => path.join(supersurfDir(), 'daemon', 'resume.json');

export interface SnapSession {
  id: string;
  /** The shim connection's handshake `sessionId`. */
  shim: string;
  ownedTabs: number[];
  createdTabs: number[];
  attachedTabId: number | null;
  groupId: number | null;
  profileId: string | null;
  experiments: Record<string, boolean>;
}
export interface SnapBrowser { profile: string; pid: number }
export interface Snapshot { v: 1; oldpid: number; ts: number; sessions: SnapSession[]; browsers: SnapBrowser[] }

export type LoadResult =
  | { ok: true; snap: Snapshot }
  | { ok: false; reason: 'missing' | 'corrupt' | 'wrong_pid' | 'stale' | 'bad_shape' };

export function writeSnapshot(s: Snapshot): void {
  const p = snapshotPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(p + '.tmp', p);
}

export function deleteSnapshot(): boolean {
  try { fs.unlinkSync(snapshotPath()); return true; } catch { return false; }
}

const isInt = (x: unknown): x is number => Number.isInteger(x);
const intList = (x: unknown): boolean => Array.isArray(x) && x.every(isInt);
const nullableInt = (x: unknown): boolean => x === null || isInt(x);

function shapeOk(s: any): boolean {
  if (!s || s.v !== 1 || !isInt(s.oldpid) || typeof s.ts !== 'number') return false;
  if (!Array.isArray(s.sessions) || !Array.isArray(s.browsers)) return false;
  const sessionOk = (x: any): boolean =>
    !!x && typeof x.id === 'string' && typeof x.shim === 'string' && intList(x.ownedTabs) && intList(x.createdTabs)
    && nullableInt(x.attachedTabId) && nullableInt(x.groupId) && (x.profileId === null || typeof x.profileId === 'string')
    && !!x.experiments && typeof x.experiments === 'object' && Object.values(x.experiments).every((v) => typeof v === 'boolean');
  return s.sessions.every(sessionOk)
    && s.browsers.every((b: any) => !!b && typeof b.profile === 'string' && isInt(b.pid));
}

/** Read, delete, then validate. A snapshot is used once, whatever the outcome. */
export function loadSnapshot(oldpid: number, now: number, maxAgeMs = 60_000): LoadResult {
  let raw: string;
  try { raw = fs.readFileSync(snapshotPath(), 'utf8'); } catch { return { ok: false, reason: 'missing' }; }
  deleteSnapshot();
  let s: any;
  try { s = JSON.parse(raw); } catch { return { ok: false, reason: 'corrupt' }; }
  if (!shapeOk(s)) return { ok: false, reason: 'bad_shape' };
  if (s.oldpid !== oldpid) return { ok: false, reason: 'wrong_pid' };
  const age = now - s.ts;
  if (age < 0 || age > maxAgeMs) return { ok: false, reason: 'stale' };
  return { ok: true, snap: s };
}

/** B2: resume needs `/proc` (the pid check below). Elsewhere the hand-off stays as today. */
export function procAvailable(): boolean {
  try { fs.readFileSync('/proc/self/cmdline'); return true; } catch { return false; }
}

/**
 * The pid is alive AND is the Chromium for this profile's user-data-dir (guards pid reuse).
 * shortcut: Linux /proc only, fails closed elsewhere; macOS needs `ps -o command= -p <pid>`.
 */
export function browserMatches(pid: number, profile: string): boolean {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return argv.includes(`--user-data-dir=${path.join(supersurfDir(), 'profiles', profile, 'chrome-data')}`);
  } catch { return false; }
}

export interface ResumeDeps {
  /** Resumable shim sessions (`ShimServer.resumableSessions`). */
  resumable: () => Array<{ id: string; shim: string }>;
  session: (id: string) => { ownedTabs: Set<number>; createdTabs: Set<number>; attachedTabId: number | null; groupId: number | null; profileId: string | null } | undefined;
  experiments: (id: string) => Record<string, boolean>;
  /** The running pid of a daemon-owned browser for this profile, else null. */
  ownedBrowserPid: (profile: string) => number | null;
  keep: (id: string) => void;
  clearKeep: () => void;
  oldpid: number;
  now: () => number;
  procOk: () => boolean;
  /** Test seam (dev env only): `off` writes nothing; `corrupt` and `stale` write a bad snapshot. */
  mode?: 'off' | 'corrupt' | 'stale';
  log: (m: string) => void;
}

/** `Handoff.prepareResume` / `cancelResume` (D2), plus the browser pids step 6 must not kill. */
export function makeResume(d: ResumeDeps): { prepare: () => number[]; cancel: () => void; keepPids: () => ReadonlySet<number> } {
  let pids = new Set<number>();
  const prepare = (): number[] => {
    if (d.mode === 'off' || !d.procOk()) return [];
    const sessions: SnapSession[] = [];
    for (const r of d.resumable()) {
      const s = d.session(r.id);
      if (!s) continue;
      sessions.push({
        id: r.id, shim: r.shim, ownedTabs: [...s.ownedTabs], createdTabs: [...s.createdTabs],
        attachedTabId: s.attachedTabId, groupId: s.groupId, profileId: s.profileId, experiments: d.experiments(r.id),
      });
    }
    if (sessions.length === 0) return [];
    const browsers: SnapBrowser[] = [];
    for (const profile of new Set(sessions.map((s) => s.profileId).filter((p): p is string => p !== null))) {
      const pid = d.ownedBrowserPid(profile);
      if (pid !== null) browsers.push({ profile, pid });
    }
    const ts = d.mode === 'stale' ? d.now() - 120_000 : d.now();
    if (d.mode === 'corrupt') {
      fs.mkdirSync(path.dirname(snapshotPath()), { recursive: true });
      fs.writeFileSync(snapshotPath(), 'not json', { mode: 0o600 });
    } else {
      writeSnapshot({ v: 1, oldpid: d.oldpid, ts, sessions, browsers });
    }
    for (const s of sessions) d.keep(s.id);
    pids = new Set(browsers.map((b) => b.pid));
    d.log(`[Daemon] Resume snapshot: ${sessions.length} session(s), ${browsers.length} browser(s)`);
    return [...pids];
  };
  const cancel = (): void => {
    pids = new Set();
    deleteSnapshot();
    d.clearKeep();
  };
  return { prepare, cancel, keepPids: () => pids };
}
