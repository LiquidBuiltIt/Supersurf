import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { startFakeDaemon, type FakeDaemon } from './fake-daemon';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(REPO, 'server', 'package.json'), 'utf8'),
).version;

export interface Sandbox {
  home: string;
  daemon: FakeDaemon;
}

export interface SandboxOptions {
  version: string | null;
  activeSessionCount: number | null;
}

/**
 * Throwaway HOME + fake daemon + a harmless process whose pid sits in the pidfile,
 * so `ensureDaemon` sees a live daemon and spawns nothing. Never touches ~/.supersurf.
 */
export async function withSandbox<T>(opts: SandboxOptions, fn: (sb: Sandbox) => Promise<T>): Promise<T> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-golden-')));
  const holder: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  let daemon: FakeDaemon | undefined;
  try {
    daemon = await startFakeDaemon({ home, expectedVersion: SERVER_VERSION, ...opts });
    fs.writeFileSync(path.join(home, '.supersurf', 'daemon.pid'), String(holder.pid));
    return await fn({ home, daemon });
  } finally {
    await daemon?.close().catch(() => {});
    holder.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export interface Call { id: number; method: string; params: unknown }

/** Drive `node server/dist/cli.js --script-mode`: one request line, wait for its reply, repeat. */
export async function runScriptMode(home: string, calls: Call[]): Promise<Record<number, any>> {
  const child = spawn(process.execPath, [path.join(REPO, 'server', 'dist', 'cli.js'), '--script-mode'], {
    cwd: home,
    env: { ...process.env, HOME: home, SUPERSURF_EXPERIMENTS: 'fingerprinting' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiters = new Map<number, (v: any) => void>();
  let buf = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        const w = m.id !== undefined ? waiters.get(m.id) : undefined;
        if (w) { waiters.delete(m.id); w(m); }
      } catch { /* not a JSON line */ }
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));

  const out: Record<number, any> = {};
  try {
    for (const c of calls) {
      const reply = new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no reply to ${c.method} (id ${c.id}). stderr:\n${stderr}`)), 80_000);
        waiters.set(c.id, (v) => { clearTimeout(t); resolve(v); });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: c.id, method: c.method, params: c.params }) + '\n');
      out[c.id] = await reply;
    }
  } finally {
    child.stdin.end();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    child.kill('SIGKILL');
  }
  return out;
}

/** Strip the parts that legitimately differ per run: temp HOME, server version, durations, run ids. */
export function normalize(value: unknown, home: string, serverVersion: string): unknown {
  const text = JSON.stringify(value)
    .split(home).join('<HOME>')
    .split(serverVersion).join('<SERVER_VERSION>')
    .replace(/\d+ms/g, '<N>ms')
    .replace(/playbook-golden-\d+-\d+/g, 'playbook-golden-<RUN>');
  return JSON.parse(text);
}

const SNAP_DIR = path.join(REPO, 'scripts', 'golden', 'snapshots');

/** Compare with the recorded snapshot. `GOLDEN_UPDATE=1` records (Task 1 only, on unmoved code). */
export function expectGolden(name: string, value: unknown): void {
  const file = path.join(SNAP_DIR, `${name}.json`);
  const text = JSON.stringify(value, null, 2) + '\n';
  if (process.env.GOLDEN_UPDATE === '1') {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  if (!fs.existsSync(file)) throw new Error(`snapshot ${name}.json missing: record it on UNMOVED code with GOLDEN_UPDATE=1`);
  expect(text).toBe(fs.readFileSync(file, 'utf8'));
}
