/**
 * E9 browser rig: real BUILT daemons, the real Go shim as the MCP client, and a real headless
 * Chromium with the built extension, all in a throwaway HOME on a free port (never 5555).
 *
 * - The extension is a patched copy: every `5555` in `dist/**\/*.js` becomes the scenario's port (a
 *   fresh Chromium profile has no `mcpPort`, so the extension falls back to the hardcoded one).
 * - The daemons run from the worktree's `daemon/dist/main.js` with `SUPERSURF_DEV_ENVIRONMENT` set to
 *   a fake root that holds `package.json`, the patched `extension/` and a `daemon` symlink to the
 *   worktree's `daemon/` (so `shim ensure` takes the dev path and no extension is pulled).
 * - `profiles.chrome_path` is a wrapper that `exec`s Chromium headless and without a sandbox.
 * - Cleanup kills only processes whose environment or command line names the test HOME.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DaemonRig, DAEMON_PKG, MAIN, freePort, request, sleep, waitFor } from './real-daemon';
import { findChromiumBinary } from '../../src/profiles/chrome';

export { freePort, sleep, waitFor, request, MAIN };
export const alive = (pid: number | null | undefined): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

/** An ELF Chromium: the `/usr/bin/chromium` launcher script would add a layer; prefer the real binary. */
export function chromiumBinary(): string | null {
  for (const p of ['/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium-browser', '/opt/google/chrome/chrome']) if (fs.existsSync(p)) return p;
  return findChromiumBinary();
}

const EXT_SRC = path.resolve(DAEMON_PKG, '..', 'extension');

/** Throwaway fake dev root with a port-patched copy of the built extension. */
function makeRoot(home: string, port: number): string {
  const root = path.join(home, 'root');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'supersurf' }));
  fs.symlinkSync(DAEMON_PKG, path.join(root, 'daemon'));
  const ext = path.join(root, 'extension');
  fs.cpSync(EXT_SRC, ext, { recursive: true, filter: (s) => !s.includes(`${path.sep}node_modules`) && !s.includes(`${path.sep}tests`) && !s.includes(`${path.sep}src`) });
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.js')) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/5555/g, String(port)));
    }
  };
  walk(path.join(ext, 'dist'));
  const left: string[] = [];
  const scan = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) scan(f);
      else if (f.endsWith('.js') && fs.readFileSync(f, 'utf8').includes('5555')) left.push(f);
    }
  };
  scan(path.join(ext, 'dist'));
  if (left.length) throw new Error(`5555 left in the extension copy: ${left.join(', ')}`);
  return root;
}

export class ResumeRig extends DaemonRig {
  readonly root: string;
  readonly fixturePort: number;
  readonly shimBin: string;
  readonly chrome: string;
  private shims: McpShim[] = [];

  /** Create with `await ResumeRig.create(...)`: the free port is needed before the extension copy. */
  private constructor(public readonly fixedPort: number, shimBin: string, chrome: string, fixturePort: number) {
    super();
    this.port = fixedPort;
    this.shimBin = shimBin;
    this.chrome = chrome;
    this.fixturePort = fixturePort;
    this.root = makeRoot(this.home, fixedPort);
    const wrapper = path.join(this.home, 'chrome.sh');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${chrome} --headless=new --no-sandbox --remote-debugging-port=0 "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify({ daemon: { idle_timeout_ms: 600_000 }, profiles: { chrome_path: wrapper } }));
  }

  static async create(shimBin: string, chrome: string, fixturePort: number): Promise<ResumeRig> {
    return new ResumeRig(await freePort(), shimBin, chrome, fixturePort);
  }

  /** A fixture URL private to this rig (the page server counts loads per URL). */
  pagePath(p: string) { return `${p}?r=${this.fixedPort}`; }
  pageUrl(p: string) { return `http://127.0.0.1:${this.fixturePort}${this.pagePath(p)}`; }
  get snapshot() { return path.join(this.daemonDir, 'resume.json'); }
  udd(profile: string) { return path.join(this.dir, 'profiles', profile, 'chrome-data'); }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: this.home, SUPERSURF_DEV_ENVIRONMENT: this.root, ...extra };
  }

  /** Start the daemon on this rig's fixed port (the hand-off successor keeps it). */
  async start(extraArgs: string[] = [], extraEnv: Record<string, string> = {}): Promise<number> {
    const out = fs.openSync(path.join(this.home, `daemon-${this.children.length}.out`), 'w');
    const c = spawn(process.execPath, [MAIN, '--_daemonized', '--port', String(this.port), ...extraArgs], { env: this.env(extraEnv), stdio: ['ignore', out, out] });
    this.children.push(c);
    c.on('exit', (code) => this.exits.set(c.pid!, code));
    await waitFor(async () => { try { return (await request(this.sock, { type: 'daemon_status' }, 300)).pid === c.pid; } catch { return false; } }, 15000, 'daemon IPC');
    return c.pid!;
  }

  /** The real `restart` CLI, as smoke.restart runs it. */
  restart(timeoutMs = 60_000) {
    return this.cli(['restart', '--port', String(this.port)], { SUPERSURF_SHIM_BIN: this.shimBin }, timeoutMs);
  }

  mcp(): McpShim {
    const s = new McpShim(this.shimBin, this.port, this.home);
    this.shims.push(s);
    return s;
  }

  /** Main process of the daemon-managed browser for `profile` (no `--type=`), or null. */
  browserPid(profile: string): number | null {
    return procs().find((p) => p.args.includes(`--user-data-dir=${this.udd(profile)}`) && !p.args.some((a) => a.startsWith('--type=')))?.pid ?? null;
  }

  /** Page targets of the browser whose user-data-dir is `udd`, over its DevTools socket. */
  async pageTargets(udd: string): Promise<{ id: string; url: string }[]> {
    const [dtPort, p] = fs.readFileSync(path.join(udd, 'DevToolsActivePort'), 'utf8').trim().split('\n');
    const ws = new WebSocket(`ws://127.0.0.1:${dtPort}${p}`);
    await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('devtools socket')); });
    const res: any = await new Promise((r) => { ws.onmessage = (e) => r(JSON.parse(String(e.data))); ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' })); });
    ws.close();
    return res.result.targetInfos.filter((t: any) => t.type === 'page').map((t: any) => ({ id: t.targetId, url: t.url }));
  }

  /** Kill only what this test started: every process whose environment or command line names this HOME. */
  cleanup(): void {
    for (const s of this.shims) s.kill();
    for (let pass = 0; pass < 2; pass++) {
      for (const p of procs()) {
        if (p.pid === process.pid) continue;
        if (p.env.includes(`HOME=${this.home}`) || p.args.some((a) => a.includes(this.home))) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }
    super.cleanup();
  }
}

/** Every readable process: pid, argv and environment lines. */
export function procs(): { pid: number; args: string[]; env: string[] }[] {
  const out: { pid: number; args: string[]; env: string[] }[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const args = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      let env: string[] = [];
      try { env = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0'); } catch { /* not ours */ }
      out.push({ pid: Number(d), args, env });
    } catch { /* gone */ }
  }
  return out;
}

/** An MCP client on the real shim's stdio: NDJSON JSON-RPC, every line kept. */
export class McpShim {
  child: ChildProcess;
  lines: any[] = [];
  private buf = '';
  private nextId = 1;
  constructor(shimBin: string, port: number, home: string, extraArgs: string[] = []) {
    // A minimal env keeps the shim away from the owner's SUPERSURF_* settings.
    this.child = spawn(shimBin, ['--port', String(port), ...extraArgs], { cwd: home, env: { HOME: home, PATH: process.env.PATH! }, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout!.on('data', (d) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        try { this.lines.push(JSON.parse(this.buf.slice(0, i))); } catch { /* not JSON */ }
        this.buf = this.buf.slice(i + 1);
      }
    });
  }
  get pid() { return this.child.pid!; }
  notify(method: string, params?: object) { this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  /** Send a request; resolves with the reply line. */
  send(method: string, params: object = {}, ms = 30_000): Promise<{ id: number; reply: Promise<any> }> {
    const id = this.nextId++;
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const reply = (async () => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const m = this.lines.find((l) => l.id === id);
        if (m) return m;
        await sleep(20);
      }
      throw new Error(`no reply to ${method} (id ${id}) within ${ms} ms`);
    })();
    return Promise.resolve({ id, reply });
  }
  async call(method: string, params: object = {}, ms = 30_000): Promise<any> { return (await this.send(method, params, ms)).reply; }
  /** A tool call; the text of the result, plus the error when the call failed. */
  async tool(name: string, args: object = {}, ms = 30_000): Promise<{ text: string; error?: string; raw: any }> {
    const r = await this.call('tools/call', { name, arguments: args }, ms).catch((e) => { throw new Error(`${name}: ${e.message}`); });
    return { text: (r.result?.content ?? []).map((c: any) => c.text ?? '').join('\n'), error: r.error?.message ?? (r.result?.isError ? 'tool error' : undefined), raw: r };
  }
  /** `initialize` until the daemon-hosted engine (not the shim's local answer) replies. */
  async initialize(): Promise<void> {
    for (let i = 0; i < 150; i++) {
      const r = await this.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'resume-e2e', version: '0' } });
      if (r.result?.serverInfo?.name === 'SuperSurf') { this.notify('notifications/initialized'); return; }
      await sleep(100);
    }
    throw new Error('the shim never connected to the daemon engine');
  }
  stop() { try { this.child.kill('SIGSTOP'); } catch { /* gone */ } }
  kill() { try { this.child.stdin!.end(); } catch { /* gone */ } try { this.child.kill('SIGKILL'); } catch { /* gone */ } }
}
