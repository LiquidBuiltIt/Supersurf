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
