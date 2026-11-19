import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { attachEnginePort, type EnginePortHooks } from '../src/engine-worker/main-side';
import { startEngineSide } from '../src/engine-worker/worker';
import { createEngineSide } from '../src/engine-worker/core';
import type { SessionHost } from '../src/ipc';

/** `engine/src/index` injected into the core: the inline path the brief asks for. */
let engine: any;
let home: string;
const oldHome = process.env.HOME;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2a-core-'));
  process.env.HOME = home;
  // A variable path keeps tsc from pulling engine sources into the daemon's program.
  engine = await import(/* @vite-ignore */ path.resolve(__dirname, '../../engine/src/index'));
});
afterAll(() => {
  process.env.HOME = oldHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const ports: MessagePort[] = [];
afterEach(() => { for (const p of ports.splice(0)) p.close(); });

function rig(eng: any = engine) {
  const { port1: mainEnd, port2: workerEnd } = new MessageChannel();
  ports.push(mainEnd, workerEnd);
  const registered: string[] = [];
  const closed: string[] = [];
  const host: SessionHost = {
    register(id, sink) { registered.push(id); sink.send({ type: 'session_ack', browser: 'chrome' }); return true; },
    request(_id, sink, msg) { sink.send({ jsonrpc: '2.0', id: msg.id, result: {} }); return Promise.resolve(); },
    close(id) { closed.push(id); },
    buildStatusResponse: () => ({ type: 'daemon_status', sessions: [] }),
  };
  const lines: any[] = [];
  const events: string[] = [];
  const waiters: Array<() => void> = [];
  const note = (e: string) => { events.push(e); waiters.splice(0).forEach((w) => w()); };
  const hooks: EnginePortHooks = {
    ready: () => note('ready'),
    line: (_cid, buf) => { lines.push(JSON.parse(Buffer.from(buf).toString())); note('line'); },
    end: (cid) => note(`end:${cid}`),
  };
  attachEnginePort(mainEnd, host, hooks);
  const side = startEngineSide(workerEnd, eng);
  const until = async (pred: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out; events=${events.join(',')}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  const config = { cli: {}, env: {}, file: {}, port: 5555, version: '9.9.9-test' };
  const send = (cid: string, msg: object) => mainEnd.postMessage({ t: 'line', cid, data: JSON.stringify(msg) });
  const call = async (cid: string, id: number, method: string, params: object = {}) => {
    send(cid, { jsonrpc: '2.0', id, method, params });
    await until(() => lines.some((l) => l.id === id));
    return lines.find((l) => l.id === id);
  };
  return { mainEnd, side, host, registered, closed, lines, events, until, config, send, call };
}

describe('engine worker core (inline, engine/src injected)', () => {
  it('posts ready, opens a connection and lists tools including connect', async () => {
    const r = rig();
    await r.until(() => r.events.includes('ready'));
    r.mainEnd.postMessage({ t: 'open', cid: 'shim-a', config: r.config });
    await r.call('shim-a', 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    r.send('shim-a', { jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await r.call('shim-a', 2, 'tools/list');
    expect(list.result.tools.map((t: any) => t.name)).toContain('connect');
  });

  it('a line sent right after open waits for the slow engine start instead of being dropped', async () => {
    class Slow extends engine.AgentSessionManager {
      async initialize(server: any, info: Record<string, unknown>) {
        await new Promise((r) => setTimeout(r, 100));
        return super.initialize(server, info);
      }
    }
    const r = rig({ AgentSessionManager: Slow });
    r.mainEnd.postMessage({ t: 'open', cid: 'shim-s', config: r.config });
    const init = await r.call('shim-s', 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    expect(init.result.serverInfo.version).toBe('9.9.9-test');
  });

  it('a parse error does not throw and the connection keeps working', async () => {
    const r = rig();
    r.mainEnd.postMessage({ t: 'open', cid: 'shim-b', config: r.config });
    await r.call('shim-b', 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    r.mainEnd.postMessage({ t: 'line', cid: 'shim-b', data: '{not json' });
    const list = await r.call('shim-b', 2, 'tools/list');
    expect(list.result.tools.length).toBeGreaterThan(0);
  });

  it('close disconnects the connection\'s agents and posts end', async () => {
    const r = rig();
    r.mainEnd.postMessage({ t: 'open', cid: 'shim-c', config: r.config });
    await r.call('shim-c', 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    r.send('shim-c', { jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await r.call('shim-c', 2, 'tools/call', { name: 'connect', arguments: { client_id: 'agent-c' } });
    expect(res.error).toBeUndefined();
    expect(r.registered).toContain('agent-c');

    r.mainEnd.postMessage({ t: 'close', cid: 'shim-c' });
    await r.until(() => r.events.includes('end:shim-c'));
    expect(r.closed).toContain('agent-c');
  });

  it('shutdown closes every connection', async () => {
    const r = rig();
    r.mainEnd.postMessage({ t: 'open', cid: 'shim-d', config: r.config });
    r.mainEnd.postMessage({ t: 'open', cid: 'shim-e', config: r.config });
    await r.call('shim-d', 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    r.mainEnd.postMessage({ t: 'shutdown' });
    await r.until(() => r.events.includes('end:shim-d') && r.events.includes('end:shim-e'));
  });
});

describe('engine worker core: status and env round trips (fake engine)', () => {
  /** A fake engine that hands the per-connection host to the test; a hand-driven port. */
  function fake(opts?: { closeReadyMs?: number }, Eng?: any) {
    let host: any;
    let onMsg!: (m: any) => void;
    const posted: any[] = [];
    const port = { postMessage: (m: any) => { posted.push(m); }, on: (_e: string, fn: any) => { onMsg = fn; } };
    class Mgr {
      constructor(_config: any, h: any) { host = h; }
      async initialize() {}
      async listTools() { return []; }
      async callTool() { return {}; }
      async serverClosed() {}
    }
    const side = createEngineSide(port, { AgentSessionManager: Eng ?? Mgr } as any, opts);
    onMsg({ t: 'open', cid: 'c1', config: { cli: {}, env: {}, file: {}, port: 5555, version: '0' } });
    const last = (t: string) => [...posted].reverse().find((m) => m.t === t);
    return { host: () => host, onMsg, posted, last, side };
  }
  afterEach(() => { vi.useRealTimers(); });

  it('queryDaemonStatus returns the status-res value', async () => {
    const f = fake();
    const p = f.host().queryDaemonStatus();
    const ask = f.last('status');
    f.onMsg({ t: 'status-res', rid: ask.rid, status: { type: 'daemon_status', sessions: [] } });
    expect(await p).toEqual({ type: 'daemon_status', sessions: [] });
  });

  it('envGet and envKeys return the env-res values for their connection', async () => {
    const f = fake();
    const g = f.host().envGet('KEY');
    const ask = f.last('env');
    expect(ask).toMatchObject({ cid: 'c1', op: 'get', name: 'KEY' });
    f.onMsg({ t: 'env-res', rid: ask.rid, value: 'v' });
    expect(await g).toBe('v');

    const k = f.host().envKeys();
    const ask2 = f.last('env');
    expect(ask2).toMatchObject({ cid: 'c1', op: 'keys' });
    f.onMsg({ t: 'env-res', rid: ask2.rid, keys: ['A', 'B'] });
    expect(await k).toEqual(['A', 'B']);
  });

  it('an env-res error rejects', async () => {
    const f = fake();
    const g = f.host().envGet('KEY');
    f.onMsg({ t: 'env-res', rid: f.last('env').rid, error: 'shim gone' });
    await expect(g).rejects.toThrow('shim gone');
  });

  it('a missing reply times out: status null, env rejects', async () => {
    vi.useFakeTimers();
    const f = fake();
    const s = f.host().queryDaemonStatus();
    const e = f.host().envGet('KEY');
    const assertion = expect(e).rejects.toThrow('Timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await s).toBeNull();
    await assertion;
  });

  it('shutdown settles pending replies at once instead of leaving their timers', async () => {
    vi.useFakeTimers();
    const f = fake();
    const s = f.host().queryDaemonStatus();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await f.side.shutdown();
    expect(await s).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the ask timer is unref\'d: a pending reply cannot keep the worker alive', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const f = fake();
      const p = f.host().queryDaemonStatus();
      const idx = spy.mock.calls.findIndex((c) => c[1] === 10_000);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect((spy.mock.results[idx].value as NodeJS.Timeout).hasRef()).toBe(false);
      f.onMsg({ t: 'status-res', rid: f.last('status').rid, status: null });
      await p;
    } finally { spy.mockRestore(); }
  });

  it('close posts end within the bound when the engine never finishes starting', async () => {
    class Stuck {
      constructor(_c: any, _h: any) {}
      initialize() { return new Promise<void>(() => {}); }
      async listTools() { return []; }
      async callTool() { return {}; }
      async serverClosed() {}
    }
    const f = fake({ closeReadyMs: 50 }, Stuck);
    f.onMsg({ t: 'close', cid: 'c1' });
    await vi.waitFor(() => expect(f.posted.some((m) => m.t === 'end' && m.cid === 'c1')).toBe(true), { timeout: 1000 });
  });

  it('the close-wait timer is unref\'d: a stuck engine start cannot keep the worker alive', async () => {
    class Stuck {
      constructor(_c: any, _h: any) {}
      initialize() { return new Promise<void>(() => {}); }
      async listTools() { return []; }
      async callTool() { return {}; }
      async serverClosed() {}
    }
    const spy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const f = fake({ closeReadyMs: 4242 }, Stuck);
      f.onMsg({ t: 'close', cid: 'c1' });
      const idx = spy.mock.calls.findIndex((c) => c[1] === 4242);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect((spy.mock.results[idx].value as NodeJS.Timeout).hasRef()).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('a start that finishes after the close bound is closed again, and end is still posted once', async () => {
    let finish!: () => void;
    const mgrs: any[] = [];
    class Late {
      closes = 0;
      constructor(_c: any, _h: any) { mgrs.push(this); }
      initialize() { return new Promise<void>((r) => { finish = r; }); }
      async listTools() { return []; }
      async callTool() { return {}; }
      async serverClosed() { this.closes++; }
    }
    const f = fake({ closeReadyMs: 30 }, Late);
    f.onMsg({ t: 'close', cid: 'c1' });
    await vi.waitFor(() => expect(f.posted.some((m) => m.t === 'end')).toBe(true), { timeout: 1000 });
    expect(mgrs[0].closes).toBe(1);
    finish(); // the start settles late: the connection must not stay alive
    await vi.waitFor(() => expect(mgrs[0].closes).toBe(2), { timeout: 1000 });
    f.onMsg({ t: 'close', cid: 'c1' });
    await new Promise((r) => setTimeout(r, 30));
    expect(f.posted.filter((m) => m.t === 'end')).toHaveLength(1);
  });

  it('end is posted exactly once per close, also after a repeated close and a shutdown', async () => {
    const f = fake();
    f.onMsg({ t: 'close', cid: 'c1' });
    f.onMsg({ t: 'close', cid: 'c1' });
    await vi.waitFor(() => expect(f.posted.some((m) => m.t === 'end')).toBe(true));
    await f.side.shutdown();
    expect(f.posted.filter((m) => m.t === 'end' && m.cid === 'c1')).toHaveLength(1);
  });

  it('shutdown waits for a close already in flight: stopped never precedes its end', async () => {
    let release!: () => void;
    class Slow {
      constructor(_c: any, _h: any) {}
      async initialize() {}
      async listTools() { return []; }
      async callTool() { return {}; }
      serverClosed() { return new Promise<void>((r) => { release = r; }); }
    }
    const f = fake(undefined, Slow);
    f.onMsg({ t: 'close', cid: 'c1' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const p = f.side.shutdown();
    await new Promise((r) => setTimeout(r, 30));
    expect(f.posted.some((m) => m.t === 'stopped')).toBe(false);
    release();
    await p;
    const end = f.posted.findIndex((m) => m.t === 'end' && m.cid === 'c1');
    const stopped = f.posted.findIndex((m) => m.t === 'stopped');
    expect(end).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeGreaterThan(end);
  });

  it('a ping is answered with a pong at once, even while a connection is still starting', () => {
    const f = fake();
    f.onMsg({ t: 'ping' });
    expect(f.posted.filter((m) => m.t === 'pong')).toHaveLength(1);
  });

  it('shutdown posts stopped after every connection is closed', async () => {
    const f = fake();
    await f.side.shutdown();
    const ends = f.posted.findIndex((m) => m.t === 'end' && m.cid === 'c1');
    const stopped = f.posted.findIndex((m) => m.t === 'stopped');
    expect(ends).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeGreaterThan(ends);
  });

  it('a shutdown message posts stopped', async () => {
    const f = fake();
    f.onMsg({ t: 'shutdown' });
    await vi.waitFor(() => expect(f.posted.some((m) => m.t === 'stopped')).toBe(true));
  });
});

describe('engine worker core: config built from the open inputs', () => {
  function fakeWith(inputs: any) {
    let host: any;
    let ctorConfig: any;
    let onMsg!: (m: any) => void;
    const port = { postMessage: () => {}, on: (_e: string, fn: any) => { onMsg = fn; } };
    class Mgr {
      constructor(c: any, h: any) { ctorConfig = c; host = h; }
      async initialize() {}
      async listTools() { return []; }
      async callTool() { return {}; }
      async serverClosed() {}
    }
    createEngineSide(port, { AgentSessionManager: Mgr } as any);
    onMsg({ t: 'open', cid: 'c1', config: inputs });
    return { host, ctorConfig };
  }

  it('runConfig reflects handshake env and flags, and the daemon port and version win', () => {
    const f = fakeWith({
      cli: { agents: { multi_agent: true } },
      env: { logging: { debug: 'truncate' }, experiments: { page_diffing: true } },
      file: { daemon: { port: 1 }, experiments: { fingerprinting: true } },
      port: 5599, version: '7.7.7',
    });
    const c = f.host.runConfig();
    const cfg = c.configService.get();
    expect(cfg.agents.multi_agent).toBe(true);
    expect(cfg.logging.debug).toBe('truncate');
    expect(cfg.daemon.port).toBe(5599);
    expect(c.port).toBe(5599);
    expect(c.debug).toBe(true);
    expect(c.server).toEqual({ name: 'SuperSurf', version: '7.7.7' });
    expect(f.host.packageVersion).toBe('7.7.7');
    expect(c.enabledExperiments.sort()).toEqual(['fingerprinting', 'page_diffing']);
    expect(typeof c.configService.get).toBe('function');
    expect(f.host.runConfig()).not.toBe(c);
    expect(f.ctorConfig.port).toBe(5599);
  });
});
