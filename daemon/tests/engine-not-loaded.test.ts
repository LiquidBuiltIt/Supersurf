import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SRC = path.resolve(__dirname, '../src');
const DIST = path.resolve(__dirname, '../dist');
/** The one file allowed to name the engine: it runs on the worker thread, never on main. */
const WORKER_FILE = path.join('engine-worker', 'worker.ts');
const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []);
// `engine-worker/...` is the daemon's own directory, not the engine.
const NAMES_ENGINE = /(from|require\()\s*['"][^'"]*\bengine\b(?!-)[^'"]*['"]/;
// Also catches `require(path.join(__dirname, '../engine/index.js'))`: any string literal naming the engine entry.
const NAMES_ENGINE_ENTRY = /['"`][^'"`\n]*\bengine\/index[^'"`\n]*['"`]/;

describe('E1: the daemon carries the engine but does not load it', () => {
  it('no daemon source imports or requires the engine, except the worker file', () => {
    const bad = walk(SRC)
      .map((f) => path.relative(SRC, f))
      .filter((rel) => {
        if (rel === WORKER_FILE) return false;
        const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
        return NAMES_ENGINE.test(text) || NAMES_ENGINE_ENTRY.test(text);
      });
    expect(bad).toEqual([]);
  });

  it('the worker file does name the engine', () => {
    expect(fs.readFileSync(path.join(SRC, WORKER_FILE), 'utf8')).toContain("'../engine/index.js'");
  });
});

describe('E2a: after a worker connection opens, main\'s require.cache has no engine or sharp', () => {
  /**
   * A child node process plays the daemon's main thread: it requires the BUILT main-side,
   * starts the BUILT worker, opens a connection, lists tools, then prints its own require.cache keys.
   * `loadEngineOnMain` is the mutation: it requires the engine on main, so the check must go red.
   */
  function runChild(loadEngineOnMain: boolean): { keys: string[]; tools: string[] } {
    for (const f of ['engine-worker/main-side.js', 'engine-worker/worker.js', 'engine/index.js']) {
      if (!fs.existsSync(path.join(DIST, f))) throw new Error(`dist/${f} is missing: run npm run build.engine && npm run build.daemon`);
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2a-cache-'));
    const script = `
      const { Worker } = require('node:worker_threads');
      const { attachEnginePort } = require(${JSON.stringify(path.join(DIST, 'engine-worker/main-side.js'))});
      if (${loadEngineOnMain}) require(${JSON.stringify(path.join(DIST, 'engine/index.js'))});
      const w = new Worker(${JSON.stringify(path.join(DIST, 'engine-worker/worker.js'))});
      const host = { register: () => true, request: async () => {}, close() {}, buildStatusResponse: () => ({}) };
      const send = (id, method, params) => w.postMessage({ t: 'line', cid: 'c', data: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      attachEnginePort(w, host, {
        ready() {
          w.postMessage({ t: 'open', cid: 'c', config: { cli: {}, env: {}, file: {}, port: 1, version: '0' } });
          send(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } });
        },
        line(cid, buf) {
          const m = JSON.parse(Buffer.from(buf).toString());
          if (m.id === 1) send(2, 'tools/list', {});
          if (m.id === 2) {
            console.log(JSON.stringify({ tools: m.result.tools.map((t) => t.name), keys: Object.keys(require.cache) }));
            w.terminate().then(() => process.exit(0));
          }
        },
      });
      setTimeout(() => { console.error('timeout'); process.exit(2); }, 20000);
    `;
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30000 });
    fs.rmSync(home, { recursive: true, force: true });
    if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    return { keys: out.keys, tools: out.tools };
  }
  const leaks = (keys: string[]) => keys.filter((k) => /[\\/]engine[\\/]/.test(k) || /sharp/.test(k));

  it('lists tools through the worker while main loads no engine file and no sharp', () => {
    const { keys, tools } = runChild(false);
    expect(tools).toContain('connect');
    expect(leaks(keys)).toEqual([]);
  });

  it('the check goes red when main requires the engine', () => {
    expect(leaks(runChild(true).keys).length).toBeGreaterThan(0);
  });
});

describe('E2b: after a shim_register is acked, main\'s require.cache has no engine or sharp', () => {
  /**
   * A child node process plays the daemon's main thread with the BUILT IPCServer + ShimServer and the
   * real production worker factory (a real `Worker` on dist/engine-worker/worker.js). A plain socket
   * registers as a shim, lists tools through the worker, then the child prints its require.cache keys.
   * `loadEngineOnMain` is the mutation: it requires the engine on main, so the check must go red.
   */
  function runChild(loadEngineOnMain: boolean): { keys: string[]; tools: string[] } {
    for (const f of ['ipc.js', 'shim-server.js', 'engine-worker/worker.js', 'engine/index.js']) {
      if (!fs.existsSync(path.join(DIST, f))) throw new Error(`dist/${f} is missing: run npm run build.engine && npm run build.daemon`);
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2b-cache-'));
    const d = (f: string) => JSON.stringify(path.join(DIST, f));
    const script = `
      const net = require('node:net');
      const { IPCServer } = require(${d('ipc.js')});
      const { SessionRegistry } = require(${d('session.js')});
      const { RequestScheduler } = require(${d('scheduler.js')});
      const { DaemonExperimentRegistry } = require(${d('experiments/index.js')});
      const { ProfileRegistry } = require(${d('profiles/registry.js')});
      const { ShimServer } = require(${d('shim-server.js')});
      if (${loadEngineOnMain}) require(${d('engine/index.js')});
      const home = ${JSON.stringify(home)};
      const sock = home + '/d.sock';
      const bridge = { connected: false, matchmaker: { getConnectionForProfile: () => null } };
      const sessions = new SessionRegistry();
      const experiments = new DaemonExperimentRegistry();
      const ipc = new IPCServer(sock, bridge, sessions, new RequestScheduler(bridge, sessions), experiments, new ProfileRegistry(home + '/profiles'), { port: 1, version: '0' });
      const shim = new ShimServer({ host: ipc, experiments, daemon: { configPath: home + '/config.json', port: 1, version: '0' } });
      ipc.setShimServer(shim);
      const finish = (code) => { shim.stop(); ipc.stop().then(() => process.exit(code)); };
      setTimeout(() => { console.error('timeout'); process.exit(2); }, 20000);
      ipc.start().then(() => {
        const c = net.createConnection(sock);
        let buf = '';
        const send = (o) => c.write(JSON.stringify(o) + '\\n');
        c.on('connect', () => send({ type: 'shim_register', protocol: 1, mode: 'mcp', sessionId: 'shim-0123456789abcdef', version: '0', cwd: '/', flags: {}, env: {}, caps: [] }));
        c.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\\n')) !== -1) {
            const m = JSON.parse(buf.slice(0, i));
            buf = buf.slice(i + 1);
            if (m.type === 'shim_ack') send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } });
            else if (m.type === 'shim_reject') { console.error(m.reason); finish(3); }
            else if (m.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
            else if (m.id === 2) {
              console.log(JSON.stringify({ tools: m.result.tools.map((t) => t.name), keys: Object.keys(require.cache) }));
              finish(0);
            }
          }
        });
      });
    `;
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30000 });
    fs.rmSync(home, { recursive: true, force: true });
    if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!);
    return { keys: out.keys, tools: out.tools };
  }
  const leaks = (keys: string[]) => keys.filter((k) => /[\\/]engine[\\/]/.test(k) || /sharp/.test(k));

  it('lists tools for a shim through the real worker while main loads no engine file and no sharp', () => {
    const { keys, tools } = runChild(false);
    expect(tools).toContain('connect');
    expect(keys.some((k) => k.endsWith('shim-server.js'))).toBe(true); // the shim path really ran in this process
    expect(leaks(keys)).toEqual([]);
  }, 45000);

  it('the check goes red when main requires the engine', () => {
    expect(leaks(runChild(true).keys).length).toBeGreaterThan(0);
  }, 45000);
});
