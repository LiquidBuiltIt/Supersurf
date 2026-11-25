/**
 * E5 end to end: the BUILT `supersurf-mcp` bin with `--disable-legacy-server` execs the real Go shim (built into a
 * throwaway dir), which talks to the real BUILT daemon on a free port; the engine runs in the
 * daemon. Throwaway HOME, SUPERSURF_DEV_ENVIRONMENT set so the daemon pulls no extension, never port
 * 5555. Skipped when the Go toolchain or `daemon/dist` is missing. Kills only what it started.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { MCP_BIN, makeRig, INIT, type Rig } from './helpers/relay-rig';

const REPO = path.resolve(__dirname, '..', '..');
const DAEMON_MAIN = path.join(REPO, 'daemon', 'dist', 'main.js');
const WORKER = path.join(REPO, 'daemon', 'dist', 'engine-worker', 'worker.js');
// Same candidate order as scripts/find-go.ts (a package test cannot import from scripts/).
const GO = [process.env.GO, '/home/claudebox/.local/go/bin/go', 'go']
  .filter((g): g is string => !!g)
  .find((g) => spawnSync(g, ['version'], { stdio: 'ignore' }).status === 0);
const missing = !GO ? 'no go toolchain found'
  : !fs.existsSync(DAEMON_MAIN) || !fs.existsSync(WORKER) ? 'daemon/dist is not built (npm run build.engine && npm run build.daemon)'
  : !fs.existsSync(MCP_BIN) ? 'server/dist is not built (npm run build.server)' : '';
if (missing) console.warn(`relay-e2e skipped: ${missing}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exited = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => c.once('exit', () => r())));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

function daemonStatus(sock: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    let buf = '';
    const t = setTimeout(() => { s.destroy(); reject(new Error('daemon_status timeout')); }, 5000);
    s.on('connect', () => s.write(JSON.stringify({ type: 'daemon_status' }) + '\n'));
    s.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      clearTimeout(t); s.destroy();
      try { resolve(JSON.parse(buf.slice(0, buf.indexOf('\n')))); } catch (e) { reject(e); }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

describe.skipIf(!!missing)('relay end to end (supersurf-mcp --disable-legacy-server -> Go shim -> built daemon)', () => {
  let rig: Rig, port: number, sock: string, shimBin: string;
  let daemon: ChildProcess | undefined, server: ChildProcess | undefined;
  let daemonOut = '', serverErr = '', serverBuf = '';
  const lines: any[] = [];

  const send = (o: unknown) => server!.stdin!.write(JSON.stringify(o) + '\n');
  const reply = async (id: number, ms = 15000): Promise<any> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = lines.find((l) => l.id === id);
      if (m) return m;
      await sleep(20);
    }
    throw new Error(`no reply for id ${id}; stderr: ${serverErr}; daemon: ${daemonOut.slice(-500)}`);
  };

  beforeAll(async () => {
    rig = makeRig();
    shimBin = path.join(rig.home, 'supersurf-server');
    const b = spawnSync(GO!, ['build', '-o', shimBin, '.'], { cwd: path.join(REPO, 'server', 'shim'), encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } });
    if (b.status !== 0) throw new Error(`go build failed: ${b.stderr}`);

    port = await freePort();
    sock = path.join(rig.home, '.supersurf', 'daemon.sock');
    daemon = spawn(process.execPath, [DAEMON_MAIN, '--port', String(port)], {
      env: rig.env({ SUPERSURF_DEV_ENVIRONMENT: REPO, PATH: process.env.PATH! }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stdout!.on('data', (d) => { daemonOut += d; });
    daemon.stderr!.on('data', (d) => { daemonOut += d; });
    const end = Date.now() + 20000;
    while (!(daemonOut.includes('Daemon ready') && fs.existsSync(sock))) {
      if (Date.now() > end || daemon.exitCode !== null) throw new Error(`daemon did not start: ${daemonOut}`);
      await sleep(50);
    }

    server = spawn(process.execPath, [MCP_BIN, '--disable-legacy-server'], {
      cwd: rig.home,
      env: rig.env({ SUPERSURF_SERVER_BIN: shimBin, SUPERSURF_PORT: String(port) }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    server.stdin!.on('error', () => {});
    server.stdout!.on('data', (d) => {
      serverBuf += d;
      let i: number;
      while ((i = serverBuf.indexOf('\n')) !== -1) {
        try { lines.push(JSON.parse(serverBuf.slice(0, i))); } catch { /* not a JSON line */ }
        serverBuf = serverBuf.slice(i + 1);
      }
    });
    server.stderr!.on('data', (d) => { serverErr += d; });
  }, 60000);

  afterAll(async () => {
    const serverPid = server?.pid, daemonPid = daemon?.pid;
    server?.stdin?.end();
    server?.kill('SIGKILL');
    daemon?.kill('SIGTERM');
    if (daemon) await Promise.race([exited(daemon), sleep(5000)]);
    daemon?.kill('SIGKILL');
    if (server) await exited(server);
    if (daemon) await exited(daemon);
    if (serverPid) expect(alive(serverPid)).toBe(false);
    if (daemonPid) expect(alive(daemonPid)).toBe(false);
    rig?.cleanup();
  }, 30000);

  it('the server process became the shim, and the daemon-hosted engine answers initialize and tools/list', async () => {
    if (process.platform === 'linux') {
      // execve happens a moment after spawn: wait for the pid's image to change.
      const exe = () => { try { return path.basename(fs.readlinkSync(`/proc/${server!.pid}/exe`)); } catch { return ''; } };
      for (let i = 0; i < 200 && exe() !== 'supersurf-server'; i++) await sleep(25);
      expect(exe()).toBe('supersurf-server');
    }

    // The shim answers locally until its daemon link is up; retry initialize until the engine answers.
    let init: any;
    for (let id = 100; id < 140; id++) {
      send({ ...JSON.parse(INIT), id });
      init = await reply(id);
      if (init.result.serverInfo.name === 'SuperSurf') break;
      await sleep(100);
    }
    expect(init.result.serverInfo.name).toBe('SuperSurf'); // the shim's own local answer says "supersurf"
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names: string[] = (await reply(1)).result.tools.map((t: any) => t.name);
    expect(names).toHaveLength(30);
    expect(names).toEqual(expect.arrayContaining(['connect', 'disconnect', 'status', 'browser_navigate', 'browser_snapshot']));

    // The daemon hosts the session: a shim is connected to it right now.
    const st = await daemonStatus(sock);
    expect(st.shimSessions).toBeGreaterThanOrEqual(1);
    expect(st.pid).toBe(daemon!.pid);
    expect(lines.filter((l) => l.type !== undefined)).toEqual([]); // no control line reaches the client
  }, 60000);

  it('the Node server never ran: it printed nothing and the shim started no daemon of its own', () => {
    expect(serverErr).toBe('');
    expect(fs.readFileSync(path.join(rig.home, '.supersurf', 'daemon.pid'), 'utf8').trim()).toBe(String(daemon!.pid));
  });
});
