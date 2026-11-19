import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShimServer, workerEnv } from '../src/shim-server';
import { DaemonExperimentRegistry } from '../src/experiments/index';
import type { SessionHost } from '../src/ipc';
import { FakeShim, RecordingWorker, fakeEngine, inlineWorker, until, wait } from './helpers/shim-rig';

let dir: string;
let sockPath: string;
let server: net.Server;
let shimServer: ShimServer;
let workers: RecordingWorker[];
let experiments: DaemonExperimentRegistry;
let host: SessionHost & { closed: string[] };
const shims: FakeShim[] = [];

/** The hand-off `IPCServer` does, without the rest of the daemon. */
function listen(): Promise<void> {
  server = net.createServer((socket) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      socket.removeListener('data', onData);
      shimServer.accept(socket, JSON.parse(buf.slice(0, i)), Buffer.from(buf.slice(i + 1)));
    };
    socket.on('data', onData);
  });
  return new Promise((r) => server.listen(sockPath, r));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(path.join(__dirname, '..', '.tmp-test'), 'shimsrv-'));
  sockPath = path.join(dir, 's.sock');
  workers = [];
  experiments = new DaemonExperimentRegistry();
  const closed: string[] = [];
  host = {
    closed,
    register: () => true,
    request: async () => {},
    close: (id: string) => { closed.push(id); },
    buildStatusResponse: () => ({}),
  };
  shimServer = new ShimServer({
    host,
    experiments,
    daemon: { configPath: path.join(dir, 'config.json'), port: 5599, version: '9.9.9-test' },
    startWorker: () => { const w = new RecordingWorker(); workers.push(w); return w as any; },
  });
  await listen();
});

afterEach(async () => {
  for (const s of shims.splice(0)) s.close();
  shimServer.stop();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const newShim = (o = {}) => { const s = new FakeShim(sockPath, o); shims.push(s); return s; };

describe('lazy worker and open', () => {
  it('starts no worker until the first shim_register, then one worker for every shim', async () => {
    expect(workers).toHaveLength(0);
    await newShim({ sessionId: 'shim-a' }).register();
    await newShim({ sessionId: 'shim-b' }).register();
    expect(workers).toHaveLength(1);
    expect(workers[0].of('open').map((m) => m.cid)).toEqual(['shim-a#1', 'shim-b#2']);
  });

  it('a refused handshake starts no worker', async () => {
    await newShim({ handshake: { protocol: 9 } }).register();
    expect(workers).toHaveLength(0);
  });

  it('open carries config inputs from the handshake: flags mapped, env filtered to the allowlist, daemon port and version', async () => {
    const shim = newShim({
      flags: { multi_agent: true, disable_secure_eval: true },
      env: { SUPERSURF_EXPERIMENTS: 'page_diffing', SUPERSURF_CONFIG_FILE: '/etc/evil.json', SUPERSURF_PORT: '1' },
    });
    await shim.register();
    const open = workers[0].of('open')[0];
    expect(open.config.cli).toEqual({ agents: { multi_agent: true }, security: { secure_eval: false } });
    expect(open.config.env.experiments).toEqual({ page_diffing: true });
    expect(open.config.env.daemon).toBeUndefined();
    expect(open.config.port).toBe(5599);
    expect(open.config.version).toBe('9.9.9-test');
  });

  it('open is posted before the ack is written', async () => {
    const shim = newShim();
    await shim.connect();
    let openSeenAtAck = false;
    shim.socket.once('data', () => { openSeenAtAck = workers[0]?.of('open').length === 1; });
    shim.socket.write(shim.handshakeLine());
    await until(() => shim.lines.length > 0);
    expect(openSeenAtAck).toBe(true);
  });

  it('a worker that fails to start gets the shim a shim_reject', async () => {
    const failing = new ShimServer({
      host, experiments, daemon: { configPath: path.join(dir, 'c.json'), port: 1, version: 'v' },
      startWorker: () => { throw new Error('no worker'); },
    });
    shimServer = failing;
    const shim = newShim();
    const reply = await shim.register();
    expect(reply.type).toBe('shim_reject');
    expect(reply.reason).toContain('no worker');
  });
});

describe('line relay', () => {
  it('splits on newline across chunks, skips empty lines, forwards each line as a string', async () => {
    const shim = newShim();
    await shim.register();
    shim.socket.write('{"a":1}\n\n{"b"');
    await wait(20);
    shim.socket.write(':2}\n{"c":3}\n');
    await until(() => workers[0].of('line').length === 3);
    expect(workers[0].of('line').map((m) => m.data)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(workers[0].of('line')[0].cid).toBe('shim-0123456789abcdef#1');
  });

  it('keeps a multibyte character that is split across two chunks', async () => {
    const shim = newShim();
    await shim.register();
    const bytes = Buffer.from('{"t":"é"}\n');
    shim.socket.write(bytes.subarray(0, 7)); // splits the 2-byte character
    await wait(20);
    shim.socket.write(bytes.subarray(7));
    await until(() => workers[0].of('line').length === 1);
    expect(workers[0].of('line')[0].data).toBe('{"t":"é"}');
  });

  it('drops an unterminated tail at EOF', async () => {
    const shim = newShim();
    await shim.register();
    shim.socket.write('{"a":1}\n{"jsonrpc":"2.0","id":1,"meth');
    await until(() => workers[0].of('line').length === 1);
    shim.close();
    await until(() => workers[0].of('close').length === 1);
    expect(workers[0].of('line')).toHaveLength(1);
  });

  it('a line with the env.value substring but no top-level type is forwarded', async () => {
    const shim = newShim();
    await shim.register();
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { text: '"env.value"' } });
    shim.socket.write(line + '\n');
    await until(() => workers[0].of('line').length === 1);
    expect(workers[0].of('line')[0].data).toBe(line);
  });

  it('an env.value line with no pending request is dropped, not forwarded', async () => {
    const shim = newShim();
    await shim.register();
    shim.socket.write('{"found":false,"id":77,"name":"X","type":"env.value"}\n{"x":1}\n');
    await until(() => workers[0].of('line').length === 1);
    expect(workers[0].of('line')[0].data).toBe('{"x":1}');
  });

  it('worker line is written as buf then a newline; worker end ends the socket', async () => {
    const shim = newShim();
    await shim.register();
    workers[0].emit('message', { t: 'line', cid: 'shim-0123456789abcdef#1', buf: new TextEncoder().encode('{"r":1}') });
    await until(() => shim.lines.length === 2);
    expect(shim.lines[1]).toBe('{"r":1}');
    workers[0].emit('message', { t: 'end', cid: 'shim-0123456789abcdef#1' });
    await until(() => shim.ended);
  });

  it('a worker line for a closed connection is dropped without throwing', () => {
    expect(() => workers[0]?.emit('message', { t: 'line', cid: 'gone', buf: new Uint8Array(1) })).not.toThrow();
  });
});

describe('close and worker failure', () => {
  it('socket close posts close once and forgets the connection', async () => {
    const shim = newShim();
    await shim.register();
    shim.close();
    await until(() => workers[0].of('close').length === 1);
    await wait(30);
    expect(workers[0].of('close')).toEqual([{ t: 'close', cid: 'shim-0123456789abcdef#1' }]);
  });

  for (const event of ['exit', 'error'] as const) {
    it(`worker ${event}: links close, shim sockets end, the next shim_register starts a new worker`, async () => {
      const a = newShim({ sessionId: 'shim-a' });
      const b = newShim({ sessionId: 'shim-b' });
      await a.register();
      await b.register();
      workers[0].emit('message', { t: 'link-open', lid: 1, sessionId: 'agent-1', cid: 'shim-a#1' });

      workers[0].emit(event, event === 'exit' ? 1 : new Error('boom'));

      await until(() => a.ended && b.ended);
      expect(host.closed).toEqual(['agent-1']);
      expect(workers[0].of('close')).toHaveLength(0); // the worker is gone: nothing is posted to it

      const again = newShim({ sessionId: 'shim-a' });
      expect((await again.register()).type).toBe('shim_ack');
      expect(workers).toHaveLength(2);
    });
  }

  it('stop() ends shim sockets, closes links and terminates the worker', async () => {
    const shim = newShim();
    await shim.register();
    workers[0].emit('message', { t: 'link-open', lid: 1, sessionId: 'agent-1', cid: 'shim-0123456789abcdef#1' });
    shimServer.stop();
    await until(() => shim.ended);
    expect(host.closed).toEqual(['agent-1']);
    expect(workers[0].terminated).toBe(true);
  });

  it('stop() with no worker is a no-op', () => {
    expect(() => shimServer.stop()).not.toThrow();
  });
});

describe('re-register of the same sessionId (F1)', () => {
  it('a slow close of the old connection does not end the new socket or write to it', async () => {
    const { engine } = fakeEngine(100);
    const w: any = inlineWorker(engine);
    shimServer.stop();
    shimServer = new ShimServer({
      host, experiments, daemon: { configPath: path.join(dir, 'config.json'), port: 5599, version: '9.9.9-test' },
      startWorker: () => w,
    });
    const first = newShim({ sessionId: 'shim-redial' });
    await first.register();
    first.close();
    await wait(20);
    const again = newShim({ sessionId: 'shim-redial' });
    expect((await again.register()).type).toBe('shim_ack');
    await wait(150); // the old connection's end arrives in this window
    expect(again.ended).toBe(false);
    expect(again.lines).toHaveLength(1); // the ack only
    await w.terminate();
  });

  it('a second LIVE socket with the same sessionId is still refused, and a re-register after close is accepted at once', async () => {
    const first = newShim({ sessionId: 'shim-dup' });
    await first.register();
    expect((await newShim({ sessionId: 'shim-dup' }).register()).type).toBe('shim_reject');
    first.close();
    await until(() => workers[0].of('close').length === 1);
    expect((await newShim({ sessionId: 'shim-dup' }).register()).type).toBe('shim_ack');
  });
});

describe('H14 experiment defaults', () => {
  it('a link opened for a shim starts from that shim\'s handshake experiments; one with no cid keeps the daemon default', async () => {
    experiments.applyDefaults(['smart_waiting']);
    await newShim({ sessionId: 'shim-a', env: { SUPERSURF_EXPERIMENTS: 'page_diffing' } }).register();
    workers[0].emit('message', { t: 'link-open', lid: 1, sessionId: 'agent-a', cid: 'shim-a#1' });
    workers[0].emit('message', { t: 'link-open', lid: 2, sessionId: 'other', cid: undefined });
    expect(experiments.getAll('agent-a')).toMatchObject({ page_diffing: true, smart_waiting: false });
    expect(experiments.getAll('other')).toMatchObject({ page_diffing: false, smart_waiting: true });
  });
});

describe('worker environment scrub', () => {
  it('removes the config-bearing SUPERSURF_* names and every SUPERSURF_DISABLE_*, keeps the rest', () => {
    const out = workerEnv({
      HOME: '/h', PATH: '/p', SUPERSURF_DEV_ENVIRONMENT: '/dev',
      SUPERSURF_DEBUG: '1', SUPERSURF_EXPERIMENTS: 'x', SUPERSURF_DISABLE_SECURE_EVAL: '1',
      SUPERSURF_DISABLE_PLAYBOOK_EVAL: '1', SUPERSURF_DISABLE_FUTURE: '1', SUPERSURF_MULTI_AGENT: '1',
      SUPERSURF_SCREENSHOT_OMIT_PATH: '1', SUPERSURF_CONFIG_FILE: '/c', SUPERSURF_PORT: '1',
      SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK: '1',
    });
    expect(out).toEqual({ HOME: '/h', PATH: '/p', SUPERSURF_DEV_ENVIRONMENT: '/dev' });
  });
});

describe('worker-built config (inline fake engine)', () => {
  it('the manager gets a ConfigService that reflects the handshake and the daemon port', async () => {
    const { engine, log } = fakeEngine();
    const w: any = inlineWorker(engine);
    shimServer.stop();
    shimServer = new ShimServer({
      host, experiments, daemon: { configPath: path.join(dir, 'config.json'), port: 5599, version: '9.9.9-test' },
      startWorker: () => w,
    });
    const shim = newShim({ flags: { disable_secure_eval: true }, env: { SUPERSURF_PORT: '1', SUPERSURF_EXPERIMENTS: 'fingerprinting' } });
    await shim.register();
    await until(() => log.configs.length === 1);
    const cfg = log.configs[0];
    expect(cfg.configService.get().security.secure_eval).toBe(false);
    expect(cfg.port).toBe(5599);
    expect(cfg.enabledExperiments).toEqual(['fingerprinting']);
    expect(cfg.server).toEqual({ name: 'SuperSurf', version: '9.9.9-test' });
    await w.terminate();
  });
});
