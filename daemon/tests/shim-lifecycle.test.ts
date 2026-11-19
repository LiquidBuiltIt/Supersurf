import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { ShimServer, type ShimServerOptions } from '../src/shim-server';
import { IPCServer } from '../src/ipc';
import { SessionRegistry } from '../src/session';
import { RequestScheduler } from '../src/scheduler';
import { DaemonExperimentRegistry } from '../src/experiments/index';
import { ProfileRegistry } from '../src/profiles/registry';
import type { ExtensionBridge } from '../src/extension-bridge';
import type { SessionHost } from '../src/ipc';
import { FakeShim, RecordingWorker, until, wait } from './helpers/shim-rig';

const MIN = 60_000;
let dir: string;
let sockPath: string;
let server: net.Server;
let shimServer: ShimServer;
let workers: RecordingWorker[];
let host: SessionHost & { closed: string[] };
let clock: number;
let logs: string[];
const shims: FakeShim[] = [];

function listen(accept: (s: net.Socket, hs: any, rest: Buffer) => void): Promise<void> {
  server = net.createServer((socket) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      socket.removeListener('data', onData);
      accept(socket, JSON.parse(buf.slice(0, i)), Buffer.from(buf.slice(i + 1)));
    };
    socket.on('data', onData);
  });
  return new Promise((r) => server.listen(sockPath, r));
}

function make(extra: Partial<ShimServerOptions> = {}): ShimServer {
  return new ShimServer({
    host,
    experiments: new DaemonExperimentRegistry(),
    daemon: { configPath: path.join(dir, 'config.json'), port: 5599, version: '9.9.9-test' },
    startWorker: () => { const w = new RecordingWorker(); workers.push(w); return w as any; },
    now: () => clock,
    log: (m) => logs.push(m),
    ...extra,
  });
}

beforeEach(async () => {
  const baseDir = path.join(__dirname, '..', '.tmp-test');
  fs.mkdirSync(baseDir, { recursive: true });
  dir = fs.mkdtempSync(path.join(baseDir, 'shimlife-'));
  sockPath = path.join(dir, 's.sock');
  workers = [];
  logs = [];
  clock = 1_000_000;
  const closed: string[] = [];
  host = { closed, register: () => true, request: async () => {}, close: (id: string) => { closed.push(id); }, buildStatusResponse: () => ({}) };
  shimServer = make();
  await listen((s, hs, rest) => shimServer.accept(s, hs, rest));
});

afterEach(async () => {
  for (const s of shims.splice(0)) s.close();
  await shimServer.stop(20);
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const newShim = (o = {}) => { const s = new FakeShim(sockPath, o); shims.push(s); return s; };

/** Register a shim (must be acked), then make the current worker fail with `event`. */
async function crash(i: number, event: 'error' | 'exit' = 'error', arg?: unknown): Promise<void> {
  const s = newShim({ sessionId: `shim-${i}` });
  expect((await s.register()).type).toBe('shim_ack');
  workers.at(-1)!.emit(event, arg ?? (event === 'error' ? new Error(`boom ${i}`) : 1));
  await until(() => s.ended);
}

describe('crash budget', () => {
  it('three crashes in 5 minutes still start a worker; the 4th bans shim_register with a shim_reject naming count, window and last error', async () => {
    for (let i = 1; i <= 3; i++) await crash(i);
    expect((await newShim({ sessionId: 'shim-ok' }).register()).type).toBe('shim_ack');
    workers.at(-1)!.emit('error', new Error('boom 4'));
    await wait(20);
    const banned = await newShim({ sessionId: 'shim-late' }).register();
    expect(banned.type).toBe('shim_reject');
    expect(banned.reason).toMatch(/crashed 4 times in 5 minutes/);
    expect(banned.reason).toContain('boom 4');
    expect(banned.reason).toMatch(/refused until \d{4}-\d\d-\d\dT/);
    expect(workers).toHaveLength(4); // the refused register started no worker
    expect(logs.join('\n')).toMatch(/crashed.*boom 4/s);
    expect(logs.join('\n')).toMatch(/banned/i);
  });

  it('the ban ends after 5 minutes: the next shim_register starts a worker', async () => {
    for (let i = 1; i <= 4; i++) await crash(i);
    expect((await newShim({ sessionId: 'x' }).register()).type).toBe('shim_reject');
    clock += 5 * MIN + 1;
    expect((await newShim({ sessionId: 'y' }).register()).type).toBe('shim_ack');
    expect(workers).toHaveLength(5);
  });

  it('crashes older than 5 minutes do not count', async () => {
    for (let i = 1; i <= 3; i++) { await crash(i); clock += 2 * MIN; }
    await crash(4); // the first one is now 6 minutes old: three in the window, not four
    expect((await newShim({ sessionId: 'z' }).register()).type).toBe('shim_ack');
  });

  it('exit codes 0 and 42 are not crashes, but still tear down: sockets end, links close', async () => {
    for (const [i, code] of [[1, 0], [2, 42], [3, 0], [4, 42], [5, 0]] as const) {
      const s = newShim({ sessionId: `shim-${i}` });
      expect((await s.register()).type).toBe('shim_ack');
      workers.at(-1)!.emit('message', { t: 'link-open', lid: 1, sessionId: `agent-${i}`, cid: `shim-${i}#${i}` });
      workers.at(-1)!.emit('exit', code);
      await until(() => s.ended);
      expect(host.closed).toContain(`agent-${i}`);
    }
    expect((await newShim({ sessionId: 'after' }).register()).type).toBe('shim_ack');
  });

  it('an error followed by its exit counts once', async () => {
    for (let i = 1; i <= 3; i++) {
      const s = newShim({ sessionId: `shim-${i}` });
      await s.register();
      const w = workers.at(-1)!;
      w.emit('error', new Error('x'));
      w.emit('exit', 1);
      await until(() => s.ended);
    }
    // 3 worker crashes, not 6: still not banned
    expect((await newShim({ sessionId: 'after' }).register()).type).toBe('shim_ack');
  });

  it('a late exit of a worker that was already replaced is not counted', async () => {
    const s = newShim({ sessionId: 'shim-1' });
    await s.register();
    const old = workers[0];
    old.emit('error', new Error('x'));
    await until(() => s.ended);
    await newShim({ sessionId: 'shim-2' }).register(); // a second worker
    for (let i = 0; i < 5; i++) old.emit('exit', 1);
    expect((await newShim({ sessionId: 'shim-3' }).register()).type).toBe('shim_ack');
  });

  it('the last error is the exit code when the worker only exited', async () => {
    for (let i = 1; i <= 4; i++) await crash(i, 'exit', 7);
    const r = await newShim({ sessionId: 'q' }).register();
    expect(r.reason).toContain('exit code 7');
  });
});

describe('legacy sessions are untouched by a crash and a ban', () => {
  it('a legacy socket session keeps its registration and answers while the shim path crashes and is banned', async () => {
    await new Promise((r) => server.close(r));
    const b = {
      sendCmd: async () => ({}), sendCmdToProfile: async () => ({}),
      connected: true, browser: 'chrome', buildTime: 't', extensionVersionError: null,
      matchmaker: { getConnectionForProfile: () => null },
    } as unknown as ExtensionBridge;
    const sessions = new SessionRegistry();
    const experiments = new DaemonExperimentRegistry();
    const ipc = new IPCServer(sockPath, b, sessions, new RequestScheduler(b, sessions), experiments, new ProfileRegistry(path.join(dir, 'profiles')), { port: 5599, version: '9.9.9-test' });
    shimServer = make({ host: ipc, experiments });
    ipc.setShimServer(shimServer);
    await ipc.start();
    try {
      const legacy = net.createConnection(sockPath);
      await once(legacy, 'connect');
      const lines: any[] = [];
      let buf = '';
      legacy.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
      });
      legacy.write(JSON.stringify({ type: 'session_register', sessionId: 'legacy-1' }) + '\n');
      await until(() => lines.length === 1);
      expect(lines[0].type).toBe('session_ack');

      for (let i = 1; i <= 4; i++) await crash(i);
      expect((await newShim({ sessionId: 'banned' }).register()).type).toBe('shim_reject');

      expect(sessions.has('legacy-1')).toBe(true);
      legacy.write(JSON.stringify({ jsonrpc: '2.0', id: 'e1', method: 'experiments.get', params: {} }) + '\n');
      await until(() => lines.some((l) => l.id === 'e1'));
      legacy.end();
    } finally {
      for (const s of shims.splice(0)) s.close();
      await shimServer.stop(20);
      await ipc.stop();
      server = net.createServer(); // afterEach closes it
      await new Promise<void>((r) => server.listen(0, r));
    }
  });
});

describe('heartbeat', () => {
  it('posts a ping every heartbeatMs, and a worker that answers is left alone', async () => {
    await shimServer.stop(20);
    shimServer = make({ heartbeatMs: 20, heartbeatTimeoutMs: 100 });
    await new Promise((r) => server.close(r));
    await listen((s, hs, rest) => shimServer.accept(s, hs, rest));
    const s = newShim();
    // answer pongs from the first message on
    const reg = s.register();
    await until(() => workers.length === 1);
    workers[0].autoPong = true;
    await reg;
    await wait(350); // more than three timeouts
    expect(workers[0].of('ping').length).toBeGreaterThanOrEqual(5);
    expect(workers[0].terminated).toBe(false);
    expect(s.ended).toBe(false);
  });

  it('a worker that stops answering is torn down and terminated, and counts as one crash with the heartbeat text', async () => {
    await shimServer.stop(20);
    shimServer = make({ heartbeatMs: 20, heartbeatTimeoutMs: 100 });
    await new Promise((r) => server.close(r));
    await listen((s, hs, rest) => shimServer.accept(s, hs, rest));
    const s = newShim({ sessionId: 'shim-h' });
    await s.register();
    workers[0].emit('message', { t: 'link-open', lid: 1, sessionId: 'agent-h', cid: 'shim-h#1' });
    await until(() => workers[0].terminated, 2000);
    await until(() => s.ended);
    expect(host.closed).toEqual(['agent-h']);
    expect(logs.join('\n')).toMatch(/did not answer a heartbeat in 0\.1 s/);
    // the terminated worker's exit must not count again; two more real crashes leave the budget at 3
    const pingsAfter = workers[0].of('ping').length;
    workers[0].emit('exit', 1);
    workers[0].emit('error', new Error('late'));
    await wait(80);
    expect(workers[0].of('ping').length).toBe(pingsAfter); // interval cleared
    for (let i = 1; i <= 2; i++) {
      const x = newShim({ sessionId: `shim-${i}` });
      await x.register();
      workers.at(-1)!.emit('error', new Error('e'));
      await until(() => x.ended);
    }
    expect((await newShim({ sessionId: 'after' }).register()).type).toBe('shim_ack');
  });

  it('the heartbeat text is the last error of a ban', async () => {
    await shimServer.stop(20);
    shimServer = make({ heartbeatMs: 10, heartbeatTimeoutMs: 40 });
    await new Promise((r) => server.close(r));
    await listen((s, hs, rest) => shimServer.accept(s, hs, rest));
    for (let i = 1; i <= 4; i++) {
      const s = newShim({ sessionId: `shim-${i}` });
      await s.register();
      await until(() => s.ended, 2000);
    }
    const r = await newShim({ sessionId: 'late' }).register();
    expect(r.reason).toContain('did not answer a heartbeat in 0.04 s');
  });

  it('a real Worker stuck in a busy loop is caught by the heartbeat and terminated', async () => {
    await shimServer.stop(20);
    const code = `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (m) => {
        if (m.t === 'ping') parentPort.postMessage({ t: 'pong' });
        if (m.t === 'open') { for (;;) {} }
      });
      parentPort.postMessage({ t: 'ready' });`;
    let real!: Worker;
    shimServer = make({
      heartbeatMs: 25,
      heartbeatTimeoutMs: 200,
      startWorker: () => (real = new Worker(code, { eval: true })) as any,
    });
    await new Promise((r) => server.close(r));
    await listen((s, hs, rest) => shimServer.accept(s, hs, rest));
    const s = newShim();
    expect((await s.register()).type).toBe('shim_ack');
    await Promise.race([once(real, 'exit'), wait(5000).then(() => { throw new Error('worker was not terminated'); })]);
    await until(() => s.ended);
    expect(logs.join('\n')).toMatch(/did not answer a heartbeat/);
  });
});

describe('shutdown', () => {
  it('stop posts shutdown, waits for stopped, then tears down and terminates', async () => {
    const s = newShim({ sessionId: 'shim-s' });
    await s.register();
    const w = workers[0];
    w.autoStop = false;
    w.emit('message', { t: 'link-open', lid: 1, sessionId: 'agent-s', cid: 'shim-s#1' });
    let done = false;
    const p = shimServer.stop(1000).then(() => { done = true; });
    await wait(60);
    expect(w.of('shutdown')).toHaveLength(1);
    expect(done).toBe(false);
    expect(w.terminated).toBe(false);
    expect(host.closed).toEqual([]);
    w.emit('message', { t: 'stopped' });
    await p;
    expect(w.terminated).toBe(true);
    expect(host.closed).toEqual(['agent-s']);
    await until(() => s.ended);
  });

  it('a worker that never answers is terminated after graceMs, and the log says so', async () => {
    await newShim().register();
    workers[0].autoStop = false;
    const t0 = Date.now();
    await shimServer.stop(80);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    expect(workers[0].terminated).toBe(true);
    expect(logs.join('\n')).toMatch(/did not stop within 80 ms/);
  });

  it('while stopping, shim_register is refused with shim_reject and starts no worker', async () => {
    await newShim({ sessionId: 'a' }).register();
    workers[0].autoStop = false;
    const p = shimServer.stop(300);
    const r = await newShim({ sessionId: 'b' }).register();
    expect(r.type).toBe('shim_reject');
    expect(r.reason).toBe('The daemon is shutting down');
    expect(workers).toHaveLength(1);
    await p;
  });

  it('no crash is logged or counted when the worker exits while stopping', async () => {
    await newShim().register();
    workers[0].autoStop = false;
    const p = shimServer.stop(300);
    workers[0].emit('exit', 1);
    workers[0].emit('error', new Error('during stop'));
    await p;
    expect(logs.join('\n')).not.toMatch(/crashed/);
  });

  it('stop with no worker resolves at once', async () => {
    const t0 = Date.now();
    await shimServer.stop(2000);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe('daemon shutdown order (main.ts)', () => {
  it('awaits shim.stop() before the Chromium kill loop, drainAll, ipc.stop and bridge.stop', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function shutdown('));
    const at = (s: string) => { const i = body.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const stop = at('await shim.stop()');
    for (const later of ['profileRegistry.getRunningPid', 'scheduler.drainAll()', 'await ipc.stop()', 'await bridge.stop()']) {
      expect(stop).toBeLessThan(at(later));
    }
  });

  it('main.ts hands the ShimServer the daemon logger', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(src).toMatch(/new ShimServer\(.*log: \(m\) => logger\.log\(m\)/);
  });
});
