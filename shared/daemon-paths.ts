/**
 * Daemon file locations and liveness check, shared by daemon, server and cli.
 *
 * Everything is a function, not a constant: paths come from `os.homedir()` at
 * call time so tests can point HOME at a temp dir after import.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/** `~/.supersurf` */
export function supersurfDir(): string {
  return path.join(os.homedir(), '.supersurf');
}

/** Daemon Unix socket: `~/.supersurf/daemon.sock` */
export function sockPath(): string {
  return path.join(supersurfDir(), 'daemon.sock');
}

/** Daemon pidfile: `~/.supersurf/daemon.pid` */
export function pidPath(): string {
  return path.join(supersurfDir(), 'daemon.pid');
}

/** PID from the pidfile, or null when it is missing, unreadable, not an integer or <= 0 (0 and -1 would signal whole process groups). */
export function readDaemonPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidPath(), 'utf-8').trim(), 10);
    return Number.isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

/** True when a process with this PID exists (signal 0 probe). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when the pidfile names a live process. */
export function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  return pid !== null && isProcessAlive(pid);
}

/**
 * True when something accepts a connection on the Unix socket `sockFile`. An
 * unresponsive listener (no answer in 1 s) counts as live: callers delete a
 * socket only when this is false, so a wrong "live" is harmless and a wrong
 * "dead" cuts a running daemon off.
 */
export function isSocketLive(sockFile: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = net.createConnection(sockFile);
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(true));
  });
}
