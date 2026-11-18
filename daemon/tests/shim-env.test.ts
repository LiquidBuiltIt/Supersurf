import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IPCServer } from '../src/ipc';
import { SessionRegistry } from '../src/session';
import { RequestScheduler } from '../src/scheduler';
import { DaemonExperimentRegistry } from '../src/experiments/index';
import { ProfileRegistry } from '../src/profiles/registry';
import { ShimServer } from '../src/shim-server';
import type { ExtensionBridge } from '../src/extension-bridge';
import { FakeShim, RecordingWorker, fakeEngine, inlineWorker, until } from './helpers/shim-rig';
import net from 'node:net';
import { vi } from 'vitest';

const baseDir = path.join(__dirname, '..', '.tmp-test');
let tmpDir: string;
let sockPath: string;
let ipc: IPCServer;
let experiments: DaemonExperimentRegistry;
let shimServer: ShimServer;
const shims: FakeShim[] = [];
const workers: Array<{ terminate(): Promise<unknown> }> = [];

const bridge = () => ({
  sendCmd: vi.fn().mockResolvedValue({}), sendCmdToProfile: vi.fn().mockResolvedValue({}),
  connected: true, browser: 'chrome', buildTime: 't', extensionVersionError: null,
  matchmaker: { getConnectionForProfile: vi.fn().mockReturnValue(null) },
}) as unknown as ExtensionBridge;

function setup(opts: { envTimeoutMs?: number; startWorker?: () => any } = {}) {
  const { engine, log } = fakeEngine();
  shimServer = new ShimServer({
    host: ipc,
    experiments,
    daemon: { configPath: path.join(tmpDir, 'config.json'), port: 5599, version: '9.9.9-test' },
    envTimeoutMs: opts.envTimeoutMs,
    startWorker: opts.startWorker ?? (() => { const w = inlineWorker(engine); workers.push(w); return w; }),
  });
  ipc.setShimServer(shimServer);
  return log;
}
const newShim = (o: ConstructorParameters<typeof FakeShim>[1] = {}) => { const s = new FakeShim(sockPath, o); shims.push(s); return s; };
async function ready(shim: FakeShim) { await shim.register(); await shim.initialize(); }

beforeEach(() => {
  fs.mkdirSync(baseDir, { recursive: true });
  tmpDir = fs.mkdtempSync(path.join(baseDir, 'shimenv-'));
  sockPath = path.join(tmpDir, 'test.sock');
  const b = bridge();
  const sessions = new SessionRegistry();
  experiments = new DaemonExperimentRegistry();
  ipc = new IPCServer(sockPath, b, sessions, new RequestScheduler(b, sessions), experiments, new ProfileRegistry(path.join(tmpDir, 'profiles')), { port: 5599, version: '9.9.9-test' });
});

afterEach(async () => {
  for (const s of shims.splice(0)) s.close();
  shimServer?.stop();
  for (const w of workers.splice(0)) await w.terminate();
  await ipc.stop();
  delete process.env.SS_E2B_VAR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('env.get / env.keys reach the caller\'s shim', () => {
  it('env.get returns the shim\'s value, not the daemon\'s for the same name', async () => {
    process.env.SS_E2B_VAR = 'daemon-value';
    setup();
    await ipc.start();
    const shim = newShim({ answers: { SS_E2B_VAR: 'shim-value' } });
    await ready(shim);
    expect(await shim.call('env_get', { name: 'SS_E2B_VAR' })).toBe('shim-value');
  });

  it('env.get of a name the shim does not have is undefined, even when the daemon has it', async () => {
    process.env.SS_E2B_VAR = 'daemon-value';
    setup();
    await ipc.start();
    const shim = newShim({ answers: {} });
    await ready(shim);
    expect(await shim.call('env_get', { name: 'SS_E2B_VAR' })).toBe('undefined');
  });

  it('env.keys returns the shim\'s key names', async () => {
    setup();
    await ipc.start();
    const shim = newShim({ keys: ['A', 'B'] });
    await ready(shim);
    expect(JSON.parse(await shim.call('env_keys'))).toEqual(['A', 'B']);
  });

  it('two shims each get their own answer', async () => {
    setup();
    await ipc.start();
    const a = newShim({ sessionId: 'shim-a', answers: { K: 'from-a' } });
    const b = newShim({ sessionId: 'shim-b', answers: { K: 'from-b' } });
    await ready(a);
    await ready(b);
    expect(await a.call('env_get', { name: 'K' })).toBe('from-a');
    expect(await b.call('env_get', { name: 'K' })).toBe('from-b');
  });

  it('a second link of the same connection (a playbook run) reaches the same shim', async () => {
    setup();
    await ipc.start();
    const shim = newShim({ answers: { K: 'v' } });
    await ready(shim);
    await shim.call('connect', { client_id: 'agent' });
    await shim.call('playbook', { client_id: 'playbook-run-1' });
    // The run's host is the connection's host: its env lookups go to the same shim.
    expect(await shim.call('env_get', { name: 'K' })).toBe('v');
    expect(shim.envRequests).toHaveLength(1);
  });
});

describe('env failures', () => {
  const cid = 'shim-0123456789abcdef';
  const reply = (w: RecordingWorker, rid: number) => until(() => w.of('env-res').some((m) => m.rid === rid)).then(() => w.of('env-res').find((m) => m.rid === rid));

  function recording() {
    const w = new RecordingWorker();
    setup({ startWorker: () => w, envTimeoutMs: 60 });
    return w;
  }

  it('an unknown caller gets an error reply', async () => {
    const w = recording();
    await ipc.start();
    await ready0(w);
    w.emit('message', { t: 'env', rid: 1, cid: 'nobody', op: 'get', name: 'X' });
    expect((await reply(w, 1)).error).toMatch(/gone|no shim|not connected/i);
  });

  it('a caller that closed gets an error reply', async () => {
    const w = recording();
    await ipc.start();
    const shim = newShim();
    await shim.register();
    shim.close();
    await until(() => w.of('close').length === 1);
    w.emit('message', { t: 'env', rid: 2, cid, op: 'get', name: 'X' });
    expect((await reply(w, 2)).error).toBeTruthy();
  });

  it('pending requests reject at once when the socket closes', async () => {
    const w = recording();
    setup({ startWorker: () => w, envTimeoutMs: 5000 });
    await ipc.start();
    const shim = newShim({ silent: true });
    await shim.register();
    w.emit('message', { t: 'env', rid: 3, cid, op: 'get', name: 'X' });
    await until(() => shim.envRequests.some((l) => l.includes('env.get')));
    const t0 = Date.now();
    shim.close();
    const r = await reply(w, 3);
    expect(r.error).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a shim that never answers times out with an error', async () => {
    const w = recording();
    await ipc.start();
    const shim = newShim({ silent: true });
    await shim.register();
    w.emit('message', { t: 'env', rid: 4, cid, op: 'keys' });
    expect((await reply(w, 4)).error).toMatch(/timed out/i);
  });

  it('writes env.get and env.keys with a numeric id and the name', async () => {
    const w = recording();
    await ipc.start();
    const shim = newShim({ answers: { X: 'y' }, keys: ['K'] });
    await shim.register();
    w.emit('message', { t: 'env', rid: 5, cid, op: 'get', name: 'X' });
    w.emit('message', { t: 'env', rid: 6, cid, op: 'keys' });
    expect(await reply(w, 5)).toMatchObject({ t: 'env-res', rid: 5, value: 'y' });
    expect(await reply(w, 6)).toMatchObject({ t: 'env-res', rid: 6, keys: ['K'] });
    const sent = shim.envRequests.map((l) => JSON.parse(l));
    expect(sent.find((m) => m.type === 'env.get')).toMatchObject({ name: 'X' });
    expect(typeof sent.find((m) => m.type === 'env.get').id).toBe('number');
  });

  async function ready0(w: RecordingWorker) { await newShim().register(); expect(w.of('open')).toHaveLength(1); }
});

describe('per-connection experiment defaults on one daemon (H14)', () => {
  it('two shims and one legacy session keep separate defaults; legacy gets the daemon-wide one', async () => {
    experiments.applyDefaults(['smart_waiting']);
    setup();
    await ipc.start();
    const a = newShim({ sessionId: 'shim-a', env: { SUPERSURF_EXPERIMENTS: 'page_diffing' } });
    const b = newShim({ sessionId: 'shim-b', env: { SUPERSURF_EXPERIMENTS: 'fingerprinting,mouse_humanization' } });
    await ready(a);
    await ready(b);
    await a.call('connect', { client_id: 'agent-a' });
    await b.call('connect', { client_id: 'agent-b' });

    const legacy = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(sockPath); s.once('connect', () => resolve(s)); s.once('error', reject);
    });
    const lines: any[] = [];
    legacy.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
    legacy.write(JSON.stringify({ type: 'session_register', sessionId: 'legacy' }) + '\n');
    await until(() => lines.length === 1);
    legacy.write(JSON.stringify({ jsonrpc: '2.0', id: 'g', method: 'experiments.get', params: {} }) + '\n');
    await until(() => lines.some((l) => l.id === 'g'));

    expect(lines.find((l) => l.id === 'g').result.experiments).toMatchObject({ smart_waiting: true, page_diffing: false, fingerprinting: false });
    expect(JSON.parse(await a.call('experiments'))).toMatchObject({ page_diffing: true, smart_waiting: false, fingerprinting: false });
    expect(JSON.parse(await b.call('experiments'))).toMatchObject({ page_diffing: false, smart_waiting: false, fingerprinting: true, mouse_humanization: true });
    legacy.destroy();
  });

  it('a playbook-run link of a shim gets that shim\'s defaults too', async () => {
    experiments.applyDefaults(['smart_waiting']);
    setup();
    await ipc.start();
    const a = newShim({ env: { SUPERSURF_EXPERIMENTS: 'page_diffing' } });
    await ready(a);
    await a.call('playbook', { client_id: 'playbook-x' });
    expect(JSON.parse(await a.call('experiments'))).toMatchObject({ page_diffing: true, smart_waiting: false });
  });
});

describe('status through the shim path', () => {
  it('the status tool reports the daemon', async () => {
    setup();
    await ipc.start();
    const shim = newShim();
    await ready(shim);
    const status = JSON.parse(await shim.call('status'));
    expect(status).toMatchObject({ type: 'daemon_status', version: '9.9.9-test', port: 5599 });
  });
});
