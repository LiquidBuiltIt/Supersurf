/**
 * E2b end to end: the real Go shim binary (built into $TMPDIR) against the real BUILT daemon
 * (`dist/main.js`, so the production worker factory runs) in a throwaway HOME on a free port.
 * SUPERSURF_DEV_ENVIRONMENT points at the repo so no extension pull happens. Never port 5555,
 * never the real HOME. Skipped when the Go toolchain or `dist/` is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');
const DAEMON_MAIN = path.join(REPO, 'daemon', 'dist', 'main.js');
const WORKER = path.join(REPO, 'daemon', 'dist', 'engine-worker', 'worker.js');
const GO = [process.env.GO, '/home/claudebox/.local/go/bin/go', 'go']
  .filter((g): g is string => !!g)
  .find((g) => spawnSync(g, ['version'], { stdio: 'ignore' }).status === 0);
const missing = !GO ? 'no go toolchain found' : !fs.existsSync(DAEMON_MAIN) || !fs.existsSync(WORKER) ? 'daemon/dist is not built (npm run build.engine && npm run build.daemon)' : '';
if (missing) console.warn(`shim-e2e skipped: ${missing}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exited = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => c.once('exit', () => r())));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** The engine's tool list with no session, in a fresh manager is what the daemon-hosted engine must list. */
const BROWSER_TOOLS = ['browser_navigate', 'browser_interact', 'browser_snapshot', 'browser_tabs', 'browser_take_screenshot'];

describe.skipIf(!!missing)('shim end to end (Go shim, built daemon)', () => {
  let dir: string, home: string, shimBin: string, port: number, sock: string;
  let daemon: ChildProcess | undefined, shim: ChildProcess | undefined;
  let daemonOut = '', shimErr = '';
  let shimBuf = '';
  const shimLines: any[] = [];

  const send = (o: unknown) => shim!.stdin!.write(JSON.stringify(o) + '\n');
  const reply = async (id: number, ms = 15000): Promise<any> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = shimLines.find((l) => l.id === id);
      if (m) return m;
      await sleep(20);
    }
    throw new Error(`no reply for id ${id}; shim stderr: ${shimErr}; daemon: ${daemonOut.slice(-500)}`);
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2b-e2e-'));
    home = path.join(dir, 'home');
    fs.mkdirSync(home);
    shimBin = path.join(dir, 'supersurf-shim');
    const b = spawnSync(GO!, ['build', '-o', shimBin, '.'], { cwd: path.join(REPO, 'shim'), encoding: 'utf8' });
    if (b.status !== 0) throw new Error(`go build failed: ${b.stderr}`);

    port = await freePort();
    sock = path.join(home, '.supersurf', 'daemon.sock');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SUPERSURF_DEV_ENVIRONMENT: REPO };
    delete env.VITEST;
    daemon = spawn(process.execPath, [DAEMON_MAIN, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout!.on('data', (d) => { daemonOut += d; });
    daemon.stderr!.on('data', (d) => { daemonOut += d; });
    const end = Date.now() + 20000;
    while (!(daemonOut.includes('Daemon ready') && fs.existsSync(sock))) {
      if (Date.now() > end || daemon.exitCode !== null) throw new Error(`daemon did not start: ${daemonOut}`);
      await sleep(50);
    }

    // The daemon is already up, so the shim's ensure path has nothing to do; a minimal env keeps the
    // shim away from the owner's SUPERSURF_* settings. cwd is the throwaway dir (no .env there).
    // --multi-agent: a nameless `status` is then health only, the path that calls the daemon's status.
    shim = spawn(shimBin, ['--port', String(port), '--multi-agent'], { cwd: dir, env: { HOME: home, PATH: process.env.PATH! }, stdio: ['pipe', 'pipe', 'pipe'] });
    shim.stdout!.on('data', (d) => {
      shimBuf += d;
      let i: number;
      while ((i = shimBuf.indexOf('\n')) !== -1) {
        try { shimLines.push(JSON.parse(shimBuf.slice(0, i))); } catch { /* not a JSON line */ }
        shimBuf = shimBuf.slice(i + 1);
      }
    });
    shim.stderr!.on('data', (d) => { shimErr += d; });
  }, 60000);

  afterAll(async () => {
    const shimPid = shim?.pid, daemonPid = daemon?.pid;
    shim?.stdin?.end();
    shim?.kill('SIGKILL');
    daemon?.kill('SIGTERM');
    if (daemon) await Promise.race([exited(daemon), sleep(5000)]);
    daemon?.kill('SIGKILL');
    if (shim) await exited(shim);
    if (daemon) await exited(daemon);
    if (shimPid) expect(alive(shimPid)).toBe(false);
    if (daemonPid) expect(alive(daemonPid)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it('initialize, tools/list and status are answered by the daemon-hosted engine', async () => {
    // The shim answers locally until its daemon link is up; retry initialize until the engine answers.
    let init: any;
    for (let id = 100; id < 140; id++) {
      send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
      init = await reply(id);
      if (init.result.serverInfo.name === 'SuperSurf') break;
      await sleep(100);
    }
    expect(init.result.serverInfo.name).toBe('SuperSurf'); // the shim's own local answer says "supersurf"
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools: any[] = (await reply(1)).result.tools;
    const names: string[] = tools.map((t) => t.name);
    console.log(`shim-e2e tools (${names.length}): ${names.join(', ')}`);
    expect(names.length).toBeGreaterThan(1); // the shim's local list has only `status`
    expect(names).toEqual(expect.arrayContaining(['connect', 'disconnect', 'status', ...BROWSER_TOOLS]));

    // The handshake flag reached the worker's config: multi-agent injects `username` into browser tools.
    expect(Object.keys(tools.find((t) => t.name === 'browser_navigate').inputSchema.properties)).toContain('username');

    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } });
    const st = await reply(2);
    const text: string = st.result.content[0].text;
    const version = JSON.parse(fs.readFileSync(path.join(REPO, 'daemon', 'package.json'), 'utf8')).version;
    // Health-only status asks the daemon (`_status` -> buildStatusResponse); the daemon version is the proof.
    expect(text).toMatch(new RegExp(`Daemon: v${version.replace(/\./g, '\\.')}, up \\d+s`));
  }, 60000);

  it('the shim did not start a daemon of its own', () => {
    expect(fs.readFileSync(path.join(home, '.supersurf', 'daemon.pid'), 'utf8').trim()).toBe(String(daemon!.pid));
    expect(fs.existsSync(path.join(home, '.supersurf', 'spawns.jsonl'))).toBe(false);
  });
});
