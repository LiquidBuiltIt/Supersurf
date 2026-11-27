/**
 * Real-process rig for E4 restart and D3 tests: a throwaway HOME (short path: `daemon.sock.next`
 * must fit the 108-byte socket limit), a free port, and the BUILT `dist/main.js`.
 * SUPERSURF_DEV_ENVIRONMENT points at the repo so no extension pull happens. Never touches the
 * real HOME or port 5555. Needs `npm run build.daemon`.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { isProcessAlive } from 'shared';

export const REPO = path.resolve(__dirname, '../../..');
export const DAEMON_PKG = path.resolve(__dirname, '../..');
export const MAIN = path.join(DAEMON_PKG, 'dist', 'main.js');
export const PKG_VERSION: string = JSON.parse(fs.readFileSync(path.join(DAEMON_PKG, 'package.json'), 'utf8')).version;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

export async function waitFor(fn: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** One NDJSON request/reply on a Unix socket. */
export function request(sock: string, msg: object, timeoutMs = 5000): Promise<any> {
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

export class DaemonRig {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'd3-'));
  port = 0;
  readonly dir = path.join(this.home, '.supersurf');
  readonly daemonDir = path.join(this.dir, 'daemon');
  children: ChildProcess[] = [];
  exits = new Map<number, number | null>();
  extraPids = new Set<number>();
  cliPids = new Set<number>();

  constructor() {
    fs.mkdirSync(this.daemonDir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify({ daemon: { idle_timeout_ms: 600_000 } }));
  }

  get sock() { return path.join(this.dir, 'daemon.sock'); }
  get pidFile() { return path.join(this.dir, 'daemon.pid'); }
  daemonLog(): string { try { return fs.readFileSync(path.join(this.dir, 'logs', 'daemon.log'), 'utf8'); } catch { return ''; } }
  spawns(): any[] {
    try { return fs.readFileSync(path.join(this.daemonDir, 'spawns.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: this.home, SUPERSURF_DEV_ENVIRONMENT: REPO, ...extra };
  }

  writeEntry(version: string): void {
    fs.writeFileSync(path.join(this.daemonDir, 'entry'), JSON.stringify({ node: process.execPath, main: process.execPath, version }));
  }

  /** Start the real daemon directly (the `start` subcommand would daemonize) and wait for its IPC. */
  async start(extraArgs: string[] = [], extraEnv: Record<string, string> = {}): Promise<number> {
    this.port = await freePort();
    const out = fs.openSync(path.join(this.home, `daemon-${this.children.length}.out`), 'w');
    const c = spawn(process.execPath, [MAIN, '--_daemonized', '--port', String(this.port), ...extraArgs], { env: this.env(extraEnv), stdio: ['ignore', out, out] });
    this.children.push(c);
    c.on('exit', (code) => this.exits.set(c.pid!, code));
    await waitFor(async () => { try { return (await request(this.sock, { type: 'daemon_status' }, 300)).pid === c.pid; } catch { return false; } }, 10000, 'daemon IPC');
    return c.pid!;
  }

  status(): Promise<any> { return request(this.sock, { type: 'daemon_status' }, 2000); }

  /** A legacy `session_register` client; `close()` ends it. */
  async legacySession(id: string): Promise<{ close(): void }> {
    const socket = net.createConnection(this.sock);
    await new Promise<void>((r, j) => { socket.once('connect', () => r()); socket.once('error', j); });
    let buf = '';
    socket.on('error', () => {});
    socket.write(JSON.stringify({ type: 'session_register', sessionId: id }) + '\n');
    await new Promise<void>((r) => socket.on('data', (d) => { buf += d; if (buf.includes('session_ack')) r(); }));
    return { close: () => socket.destroy() };
  }

  /** Run `main.js <args>` as the CLI, in this HOME; resolves with its output and exit code. */
  cli(args: string[], extraEnv: Record<string, string> = {}, timeoutMs = 60000, main = MAIN): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      // Own process group: a kill must also reach the `ensure --install` shim the CLI runs, or it keeps copying into a HOME that cleanup is removing.
      const c = spawn(process.execPath, [main, ...args], { env: this.env(extraEnv), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      this.cliPids.add(c.pid!);
      let out = '';
      c.stdout!.on('data', (d) => { out += d; });
      c.stderr!.on('data', (d) => { out += d; });
      const t = setTimeout(() => this.killCli(c.pid!), timeoutMs);
      c.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
    });
  }

  private killCli(pid: number): void { try { process.kill(-pid, 'SIGKILL'); } catch {} }

  cleanup(): void {
    for (const p of this.cliPids) this.killCli(p);
    const pids = new Set<number>(this.extraPids);
    for (const c of this.children) if (c.pid) pids.add(c.pid);
    for (const r of this.spawns()) if (r.pid) pids.add(r.pid);
    try { const p = parseInt(fs.readFileSync(this.pidFile, 'utf8'), 10); if (p > 0) pids.add(p); } catch {}
    for (const p of pids) if (isProcessAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    fs.rmSync(this.home, { recursive: true, force: true });
  }
}
