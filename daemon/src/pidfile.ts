/**
 * Pidfile lock and content-matched cleanup for the daemon's own files.
 *
 * The pidfile is the single-instance lock (`wx`: create-exclusive), and a
 * daemon only ever removes files it can prove are its own: the pidfile if it
 * still holds this pid, the socket if it still has the identity this process
 * bound. A losing daemon, a crash handler or a stray `cleanupFiles` therefore
 * cannot delete a winner's files. Every path is a parameter so tests never
 * touch `~/.supersurf`.
 *
 * @module pidfile
 */

import fs from 'fs';
import net from 'net';
import { isProcessAlive } from 'shared';

const readPid = (pidFile: string): number | null => {
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  return Number.isNaN(pid) || pid <= 0 ? null : pid;
};

/**
 * Take the pidfile lock. `acquired: false` names the live daemon that holds
 * it. A file naming a dead (or unparsable, or this) pid is stale and replaced.
 */
export function acquirePidFile(pidFile: string): { acquired: true } | { acquired: false; pid: number } {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx', mode: 0o600 });
      return { acquired: true };
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
    let held = '';
    // Empty means a writer sits between create and write (this lock, or a 4.x daemon's truncate):
    // wait it out for up to ~1 s before calling the file stale.
    for (let wait = 0; wait < 20 && held.trim() === ''; wait++) {
      if (wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      try { held = fs.readFileSync(pidFile, 'utf8'); } catch { held = ''; break; }
    }
    if (held === '' && !fs.existsSync(pidFile)) continue; // vanished: retry the create
    const pid = parseInt(held.trim(), 10);
    if (pid > 0 && pid !== process.pid && isProcessAlive(pid)) return { acquired: false, pid };
    // shortcut: read-then-unlink is not atomic; a rival that replaces the stale file in
    // between loses its lock. Re-checking the content narrows that to microseconds; the
    // real fix is a rename-based takeover (E4), not worth it for a stale-file edge case.
    try { if (fs.readFileSync(pidFile, 'utf8') === held) fs.unlinkSync(pidFile); } catch {}
  }
  throw new Error(`could not take the pidfile lock at ${pidFile}`);
}

/** Inode plus ctime: a recycled inode number alone does not prove it is the same socket. */
export interface SockIdentity { ino: number; ctimeMs: number }

export function sockIdentity(sockFile: string): SockIdentity {
  const { ino, ctimeMs } = fs.lstatSync(sockFile);
  return { ino, ctimeMs };
}

/**
 * Remove the pidfile if it holds this pid and the socket if it still has the
 * identity this process bound (`bound`, null when it never bound one).
 */
export function releaseFiles(pidFile: string, sockFile: string, bound: SockIdentity | null): void {
  try { if (readPid(pidFile) === process.pid) fs.unlinkSync(pidFile); } catch {}
  try {
    if (bound !== null) {
      const now = sockIdentity(sockFile);
      if (now.ino === bound.ino && now.ctimeMs === bound.ctimeMs) fs.unlinkSync(sockFile);
    }
  } catch {}
}

/**
 * Make `sockFile` free to bind. Holding the pidfile lock makes any socket file
 * a leftover, but only if nothing listens on it: a live listener (a daemon
 * that lost its pidfile) is reported as `false` and left alone.
 */
export async function clearStaleSocket(sockFile: string): Promise<boolean> {
  if (!fs.existsSync(sockFile)) return true;
  const live = await new Promise<boolean>((resolve) => {
    const s = net.createConnection(sockFile);
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(true)); // unresponsive: assume live, never delete
  });
  if (live) return false;
  try { fs.unlinkSync(sockFile); } catch {}
  return true;
}
