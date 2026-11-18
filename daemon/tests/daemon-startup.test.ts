/**
 * M4 daemon hardening, end to end: real daemon processes in a throwaway HOME,
 * never port 5555. SUPERSURF_DEV_ENVIRONMENT points at the repo so the
 * extension pull is skipped (no network); the listen-before-pull test removes
 * it and stubs https instead.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

const REPO = path.resolve(__dirname, '..', '..');
const MAIN = path.join(REPO, 'daemon', 'src', 'main.ts');

interface Daemon { child: ChildProcess; out: () => string; exited: Promise<number | null> }

const children: ChildProcess[] = [];
const homes: string[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

function makeHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'dstart-'));
  homes.push(h);
  return h;
}

function start(home: string, port: number, opts: { preload?: string; dev?: boolean } = {}): Daemon {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.VITEST;
  delete env.SUPERSURF_DEV_ENVIRONMENT;
  if (opts.dev !== false) env.SUPERSURF_DEV_ENVIRONMENT = REPO;
  const args = [...(opts.preload ? ['--require', opts.preload] : []), '--import', 'tsx', MAIN, '--port', String(port)];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let buf = '';
  child.stdout!.on('data', (d) => { buf += d; });
  child.stderr!.on('data', (d) => { buf += d; });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, out: () => buf, exited };
}

const sup = (home: string, f: string) => path.join(home, '.supersurf', f);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await sleep(50); }
  throw new Error('timed out waiting for condition');
}

/** One daemon_status round trip; resolves null when nothing answers. */
function status(sock: string): Promise<any | null> {
  return new Promise((resolve) => {
    const s = net.createConnection(sock);
    let buf = '';
    const done = (v: any) => { clearTimeout(t); s.destroy(); resolve(v); };
    const t = setTimeout(() => done(null), 3000);
    s.on('connect', () => s.write(JSON.stringify({ type: 'daemon_status' }) + '\n'));
    s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i !== -1) { try { done(JSON.parse(buf.slice(0, i))); } catch { done(null); } } });
    s.on('error', () => done(null));
  });
}

afterEach(async () => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch {} }
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

describe('daemon hardening (M4)', () => {
  it('makes ~/.supersurf 0700, the socket 0600 and the pidfile 0600', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.supersurf'), { mode: 0o755 });
    const d = start(home, await freePort());
    await until(() => fs.existsSync(sup(home, 'daemon.sock')) && d.out().includes('Daemon ready'));
    expect(fs.statSync(sup(home, '')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(sup(home, 'daemon.sock')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(sup(home, 'daemon.pid')).mode & 0o777).toBe(0o600);
  }, 30000);

  it('a second daemon refuses to start and leaves the winner pidfile and socket intact', async () => {
    const home = makeHome();
    const port = await freePort();
    const a = start(home, port);
    await until(() => a.out().includes('Daemon ready'));
    const b = start(home, port);
    expect(await b.exited).toBe(1);
    expect(fs.readFileSync(sup(home, 'daemon.pid'), 'utf8')).toBe(String(a.child.pid));
    expect((await status(sup(home, 'daemon.sock')))?.type).toBeTruthy();
  }, 30000);

  it('a loser whose pidfile check was bypassed still leaves the winner socket alone', async () => {
    // The spawn path used to delete a live daemon's pidfile while it was still starting.
    const home = makeHome();
    const port = await freePort();
    const a = start(home, port);
    await until(() => a.out().includes('Daemon ready'));
    fs.unlinkSync(sup(home, 'daemon.pid'));
    const b = start(home, port);
    expect(await b.exited).toBe(1);
    expect((await status(sup(home, 'daemon.sock')))?.type).toBeTruthy();
    expect(a.child.exitCode).toBeNull();
  }, 30000);

  it('two daemons started at once: one survives and owns the pidfile and socket', async () => {
    const home = makeHome();
    const port = await freePort();
    const a = start(home, port);
    const b = start(home, port);
    await Promise.race([a.exited, b.exited]);
    const survivor = a.child.exitCode === null ? a : b;
    await until(() => survivor.out().includes('Daemon ready'));
    expect(fs.readFileSync(sup(home, 'daemon.pid'), 'utf8')).toBe(String(survivor.child.pid));
    expect((await status(sup(home, 'daemon.sock')))?.type).toBeTruthy();
  }, 30000);

  it('opens the socket before the extension pull finishes', async () => {
    const home = makeHome();
    const stub = path.join(home, 'hang-https.js');
    fs.writeFileSync(stub, "const https=require('https');const {EventEmitter}=require('events');https.get=()=>new EventEmitter();\n");
    const d = start(home, await freePort(), { preload: stub, dev: false });
    await until(() => fs.existsSync(sup(home, 'daemon.sock')), 10000);
    expect((await status(sup(home, 'daemon.sock')))?.type).toBeTruthy();
    expect(d.child.exitCode).toBeNull();
  }, 30000);

  it('an uncaught exception logs, removes its own pidfile and socket, and exits 1', async () => {
    const home = makeHome();
    const boom = path.join(home, 'boom.js');
    fs.writeFileSync(boom, "setTimeout(()=>{throw new Error('boom-uncaught')},2500);\n");
    const d = start(home, await freePort(), { preload: boom });
    await until(() => fs.existsSync(sup(home, 'daemon.sock')));
    expect(await d.exited).toBe(1);
    expect(fs.existsSync(sup(home, 'daemon.pid'))).toBe(false);
    expect(fs.existsSync(sup(home, 'daemon.sock'))).toBe(false);
    expect(fs.readFileSync(sup(home, 'logs/daemon.log'), 'utf8')).toContain('boom-uncaught');
  }, 30000);

  it('an unhandled rejection does the same', async () => {
    const home = makeHome();
    const boom = path.join(home, 'boom.js');
    fs.writeFileSync(boom, "setTimeout(()=>{Promise.reject(new Error('boom-rejected'))},2500);\n");
    const d = start(home, await freePort(), { preload: boom });
    await until(() => fs.existsSync(sup(home, 'daemon.sock')));
    expect(await d.exited).toBe(1);
    expect(fs.existsSync(sup(home, 'daemon.pid'))).toBe(false);
    expect(fs.readFileSync(sup(home, 'logs/daemon.log'), 'utf8')).toContain('boom-rejected');
  }, 30000);
});
