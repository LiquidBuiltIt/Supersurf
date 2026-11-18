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

describe('E1: the daemon carries the engine but does not load it', () => {
  it('no daemon source imports or requires the engine, except the worker file', () => {
    const bad = walk(SRC)
      .map((f) => path.relative(SRC, f))
      .filter((rel) => rel !== WORKER_FILE && NAMES_ENGINE.test(fs.readFileSync(path.join(SRC, rel), 'utf8')));
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
          w.postMessage({ t: 'open', cid: 'c', config: { debug: false, port: 1, server: { name: 's', version: '0' } } });
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
