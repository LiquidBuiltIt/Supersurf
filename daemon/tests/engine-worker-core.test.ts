import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { ConfigService } from 'shared';
import { attachEnginePort, type EnginePortHooks } from '../src/engine-worker/main-side';
import { startEngineSide } from '../src/engine-worker/worker';
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
  const config = {
    debug: false, port: 5555, server: { name: 'SuperSurf', version: '9.9.9-test' },
    configService: new ConfigService({ cli: {}, env: {}, file: {} }),
  };
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
