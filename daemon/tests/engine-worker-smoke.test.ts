import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { IPCServer } from '../src/ipc';
import { SessionRegistry } from '../src/session';
import { RequestScheduler } from '../src/scheduler';
import { DaemonExperimentRegistry } from '../src/experiments/index';
import { ProfileRegistry } from '../src/profiles/registry';
import type { ExtensionBridge } from '../src/extension-bridge';
import { attachEnginePort } from '../src/engine-worker/main-side';

const WORKER = path.resolve(__dirname, '../dist/engine-worker/worker.js');
const HINT = 'run npm run build.engine && npm run build.daemon';

// The BUILT worker in a real Worker thread: the engine loads, lists tools, and a connect reaches the daemon.
describe('engine worker smoke (built dist, real Worker)', () => {
  let tmp: string;
  let worker: Worker;
  let ipc: IPCServer;
  let sessions: SessionRegistry;
  const events: string[] = [];
  const lines: any[] = [];
  const waiters: Array<() => void> = [];
  const note = (e: string) => { events.push(e); waiters.splice(0).forEach((w) => w()); };
  const until = async (pred: () => boolean) => {
    const deadline = Date.now() + 15000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out; events=${events.join(',')}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  const send = (msg: object) => worker.postMessage({ t: 'line', cid: 'shim-smoke', data: JSON.stringify(msg) });
  const call = async (id: number, method: string, params: object = {}) => {
    send({ jsonrpc: '2.0', id, method, params });
    await until(() => lines.some((l) => l.id === id));
    return lines.find((l) => l.id === id);
  };

  beforeAll(() => {
    if (!fs.existsSync(WORKER) || !fs.existsSync(path.resolve(__dirname, '../dist/engine/index.js'))) {
      throw new Error(`${WORKER} or dist/engine is missing: ${HINT}`);
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2a-smoke-'));
    const bridge = {
      sendCmd: vi.fn().mockResolvedValue({ success: true }), connected: true, browser: 'chrome',
      buildTime: '2026-01-01T00:00:00Z', extensionVersionError: null, notifyClientId: vi.fn(),
      onReconnect: null, onTabInfoUpdate: null, sendCmdToProfile: vi.fn().mockResolvedValue({}),
      matchmaker: { getConnectionForProfile: vi.fn().mockReturnValue(null), pendingSpawns: new Set<string>() },
    } as unknown as ExtensionBridge;
    sessions = new SessionRegistry();
    ipc = new IPCServer(path.join(tmp, 's.sock'), bridge, sessions, new RequestScheduler(bridge, sessions),
      new DaemonExperimentRegistry(), new ProfileRegistry(path.join(tmp, 'profiles')), { port: 5555, version: '9.9.9-test' });
    worker = new Worker(WORKER, { env: { ...process.env, HOME: tmp } });
    worker.on('error', (e) => note(`error:${e.message}`));
    attachEnginePort(worker, ipc, {
      ready: () => note('ready'),
      line: (_cid, buf) => { lines.push(JSON.parse(Buffer.from(buf).toString())); note('line'); },
      end: (cid) => note(`end:${cid}`),
    });
  });

  afterAll(async () => {
    await worker?.terminate();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists tools, connects through a link, and close posts end', async () => {
    await until(() => events.includes('ready'));
    worker.postMessage({
      t: 'open', cid: 'shim-smoke',
      config: { cli: {}, env: {}, file: {}, port: 5555, version: '9.9.9-test' },
    });
    await call(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await call(2, 'tools/list');
    const names = list.result.tools.map((t: any) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('connect');

    const res = await call(3, 'tools/call', { name: 'connect', arguments: { client_id: 'smoke-agent' } });
    expect(res.error).toBeUndefined();
    expect(ipc.buildStatusResponse().sessions.map((s: any) => s.sessionId)).toContain('smoke-agent');

    worker.postMessage({ t: 'close', cid: 'shim-smoke' });
    await until(() => events.includes('end:shim-smoke'));
    expect(ipc.buildStatusResponse().sessions.map((s: any) => s.sessionId)).not.toContain('smoke-agent');
  });
});
