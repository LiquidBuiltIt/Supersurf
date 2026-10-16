/**
 * Release-acceptance benchmark: one check per CHANGELOG `## Unreleased` entry,
 * run against a SuperSurf tree with real headless Chromium.
 *
 *   npm run bench.release -- --root <tree> --label <name> [--out file.json] [--only 3,4,E2]
 *   npm run bench.release -- --merge baseline.json main.json --report out.html
 *
 * Each check returns PASS | FAIL | SKIP plus one line of evidence. A check that
 * throws is a FAIL with the exception as evidence; it never stops the others.
 * The run uses a throwaway HOME per environment and never touches ~/.supersurf.
 * The tree under test is only read (node + Chromium load its built dist/).
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HERE = path.dirname(new URL(import.meta.url).pathname);

// ───────────────────────── result model ─────────────────────────

type Verdict = 'PASS' | 'FAIL' | 'SKIP';
interface Outcome { verdict: Verdict; evidence: string }
interface CheckResult extends Outcome { id: string }
const pass = (evidence: string): Outcome => ({ verdict: 'PASS', evidence });
const fail = (evidence: string): Outcome => ({ verdict: 'FAIL', evidence });
const skip = (evidence: string): Outcome => ({ verdict: 'SKIP', evidence });
const oneLine = (s: string, n = process.env.BENCH_VERBOSE ? 3000 : 360) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const J = (v: unknown) => oneLine(typeof v === 'string' ? v : JSON.stringify(v));

// ───────────────────────── tree under test ─────────────────────────

interface Tree {
  root: string;
  /** Version of the `supersurf-daemon` npm resolved by `server/` before relinking (null when it already was this tree's daemon). */
  registryDaemon: string | null;
  /** 5.0.0 protocol: `username` everywhere. Baseline: `client_id` on connect only. */
  isMain: boolean;
  chromium: string;
}

function describeTree(root: string): Tree {
  const isMain = fs.existsSync(path.join(root, 'server', 'dist', 'agent-session-manager.js'));
  let chromium = '/usr/bin/chromium';
  try {
    const mod = require(path.join(root, 'daemon', 'dist', 'profiles', 'chrome.js'));
    chromium = mod.findChromiumBinary() || chromium;
  } catch { /* fall back to /usr/bin/chromium */ }
  return { root, isMain, chromium, registryDaemon: prepareTree(root) };
}

/**
 * 4.0.0's server asks for `supersurf-daemon ^3.0.0`, so `npm install` puts the 3.4.0 REGISTRY daemon in
 * server/node_modules, and every connect then dies with version_mismatch. That is changelog entry 11
 * (check 11 reports it). To exercise the baseline's other behaviour for real, relink that one directory to
 * the tree's own daemon. node_modules is the only thing the harness ever writes in a tree.
 */
function prepareTree(root: string): string | null {
  const nm = path.join(root, 'server', 'node_modules', 'supersurf-daemon');
  const orig = nm + '.orig-registry';
  const ver = (d: string) => { try { return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).version as string; } catch { return null; } };
  const own = ver(path.join(root, 'daemon'));
  const st = fs.lstatSync(nm, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) {
    const v = ver(nm);
    if (v && v !== own) {
      fs.renameSync(nm, orig);
      fs.symlinkSync('../../daemon', nm);
      return v;
    }
  } else if (fs.existsSync(orig)) return ver(orig);
  return null;
}

// ───────────────────────── fixture servers ─────────────────────────

interface Fixture { port: number; url: string; hits: string[]; close: () => void }

/** Serve `routes[path]` (html or fn), plus `/hit?p=` which records beacon probes in `hits`. */
function serve(routes: Record<string, string | ((u: URL) => string)>): Promise<Fixture> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (u.pathname === '/hit') {
      hits.push(u.searchParams.get('p') || '');
      res.writeHead(204); res.end(); return;
    }
    const r = routes[u.pathname];
    if (r === undefined) { res.writeHead(404); res.end('nf'); return; }
    const ct = u.pathname.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(typeof r === 'function' ? r(u) : r);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    resolve({ port, url: `http://127.0.0.1:${port}`, hits, close: () => server.close() });
  }));
}

/** A labelled page: its port is the isolation marker, its title is the identity marker. */
function labelPage(label: string, extraBody = ''): Promise<Fixture> {
  const L = label.toUpperCase();
  return serve({
    [`/${label}-marker.js`]: `window.__marker='${label}';`,
    [`/${label}-late.js`]: `window.__late='${label}';`,
    '/': (u) => `<!doctype html><title>PAGE-${L}</title><script src="/${label}-marker.js"></script>` +
      (u.searchParams.get('late') ? `<script src="/${label}-late.js"></script>` : '') + `<h1>PAGE-${L}</h1>${extraBody}`,
  });
}

// ───────────────────────── server processes ─────────────────────────

interface Reply { text: string; isError: boolean; json: any }

/** One `cli.js` process, driven either as script-mode JSON-RPC or as an MCP stdio server. */
class Proc {
  child: ChildProcess;
  stderr = '';
  private nextId = 1;
  private pending = new Map<number, (m: any) => void>();
  private buf = '';
  constructor(readonly env: Env, readonly name: string, readonly mode: 'script' | 'mcp', extraEnv: Record<string, string> = {}, serverEntry?: string) {
    const entry = serverEntry || path.join(env.tree.root, 'server', 'dist', 'cli.js');
    this.child = spawn(process.execPath, [entry, ...(mode === 'script' ? ['--script-mode'] : [])], {
      env: { ...process.env, HOME: env.home, SUPERSURF_EXPERIMENTS: '', ...env.extraEnv, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr!.on('data', (c) => { this.stderr = (this.stderr + c.toString()).slice(-6000); });
    this.child.stdout!.on('data', (chunk) => {
      this.buf += chunk.toString();
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const r = this.pending.get(msg.id);
          if (r) { this.pending.delete(msg.id); r(msg); }
        } catch { /* log line */ }
      }
    });
  }

  private rpc(method: string, params: any, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`[${this.name}] ${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Per-tool identity param: 5.0.0 wants `username` on non-exempt tools; 4.0.0 takes none. */
  private withId(tool: string, args: any): any {
    if (!this.env.tree.isMain || 'username' in args) return args;
    return { username: this.name, ...args };
  }

  /** Initialise MCP mode (no-op in script mode). */
  async init(): Promise<void> {
    if (this.mode !== 'mcp') return;
    await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bench', version: '1' } }, 30_000);
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  /** Call one tool. Script mode returns the raw result; MCP mode the text block, parsed when it is JSON. */
  async call(tool: string, args: any = {}, timeoutMs = 60_000): Promise<Reply> {
    const a = this.withId(tool, args);
    for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
    if (this.mode === 'script') {
      const msg = await this.rpc(tool, a, timeoutMs);
      if (msg.error) return { text: String(msg.error.message), isError: true, json: { error: msg.error.message } };
      const r = msg.result;
      const isError = r?.success === false || !!r?.error || !!r?.isError;
      return { text: typeof r === 'string' ? r : JSON.stringify(r).replace(/\\"/g, '"'), isError, json: r };
    }
    const msg = await this.rpc('tools/call', { name: tool, arguments: a }, timeoutMs);
    if (msg.error) return { text: String(msg.error.message), isError: true, json: null };
    const text = (msg.result?.content ?? []).map((c: any) => c.text ?? '').join('\n');
    let json: any = null;
    const start = text.search(/[{[]/);
    if (start >= 0) { try { json = JSON.parse(text.slice(start)); } catch { /* not json */ } }
    return { text, isError: !!msg.result?.isError, json };
  }

  /** MCP `tools/list` (MCP mode only). */
  async listTools(): Promise<any[]> {
    const m = await this.rpc('tools/list', {}, 30_000);
    return m.result?.tools ?? [];
  }

  /** Connect under this process's name. */
  connect(name = this.name): Promise<Reply> {
    return this.call('connect', this.env.tree.isMain ? { username: name } : { client_id: name });
  }

  async stop(): Promise<void> {
    try { this.child.kill('SIGTERM'); } catch { /* gone */ }
    await sleep(100);
  }
}

// ───────────────────────── environment: HOME + daemon + Chromium ─────────────────────────

class Env {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-rel-'));
  userDataDir = path.join(this.home, 'chrome-data');
  chromium: ChildProcess | null = null;
  procs: Proc[] = [];
  fixtures: Fixture[] = [];
  extraEnv: Record<string, string> = {};
  extensionDir: string;
  private memo = new Map<string, Promise<any>>();
  /** Build `f()` once per environment (fixtures, scenarios shared by two checks). */
  once<T>(key: string, f: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, f());
    return this.memo.get(key)!;
  }
  constructor(readonly tree: Tree, opts: { config?: any; extensionDir?: string; extraEnv?: Record<string, string> } = {}) {
    fs.mkdirSync(path.join(this.home, '.supersurf'), { recursive: true });
    if (opts.config) fs.writeFileSync(path.join(this.home, '.supersurf', 'config.json'), JSON.stringify(opts.config));
    this.extensionDir = opts.extensionDir || path.join(tree.root, 'extension');
    this.extraEnv = opts.extraEnv || {};
    // Seed the daemon's extension cache so its first start never waits on a GitHub download.
    fs.cpSync(this.extensionDir, path.join(this.home, '.supersurf', 'extension'), { recursive: true, filter: (s) => !/node_modules/.test(s) });
  }

  proc(name: string, mode: 'script' | 'mcp' = 'script', extraEnv: Record<string, string> = {}, serverEntry?: string): Proc {
    const p = new Proc(this, name, mode, extraEnv, serverEntry);
    this.procs.push(p);
    return p;
  }

  async fixture(f: Promise<Fixture>): Promise<Fixture> { const x = await f; this.fixtures.push(x); return x; }

  launchChromium(): void {
    this.chromium = spawn(this.tree.chromium, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${this.userDataDir}`,
      `--load-extension=${this.extensionDir}`, '--no-first-run', '--no-default-browser-check',
      '--use-mock-keychain', 'about:blank',
    ], { stdio: 'ignore', detached: true });
  }

  /** `connect` spawns the daemon, so it must precede Chromium (5s extension reconnect backoff). */
  async browserUp(first: Proc, timeoutMs = 60_000): Promise<void> {
    await first.init();
    const c = await first.connect();
    if (c.isError) throw new Error(`first connect failed: ${c.text}`);
    this.launchChromium();
    const until = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < until) {
      const r = await first.call('browser_tabs', { action: 'list' }, 15_000).catch((e) => ({ isError: true, text: String(e) } as any));
      if (!r.isError) return;
      last = r.text;
      await sleep(1000);
    }
    throw new Error(`extension never reached the daemon within ${timeoutMs}ms (last: ${oneLine(last, 200)})`);
  }

  /** Live page targets according to Chromium itself. */
  async livePages(): Promise<{ id: string; url: string; title: string }[]> {
    const port = fs.readFileSync(path.join(this.userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const all: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return all.filter((t) => t.type === 'page');
  }

  stopDaemon(): void {
    try {
      const pid = Number(fs.readFileSync(path.join(this.home, '.supersurf', 'daemon.pid'), 'utf8').trim());
      if (pid > 0) process.kill(pid, 'SIGTERM');
      const until = Date.now() + 5000;
      while (Date.now() < until) { process.kill(pid, 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
    } catch { /* never started or gone */ }
  }

  async down(): Promise<void> {
    for (const p of this.procs) await p.stop();
    if (this.chromium?.pid) { try { process.kill(-this.chromium.pid, 'SIGKILL'); } catch { this.chromium.kill('SIGKILL'); } }
    this.stopDaemon();
    for (const f of this.fixtures) f.close();
    await sleep(300);
    if (!process.env.BENCH_KEEP) fs.rmSync(this.home, { recursive: true, force: true });
  }

  /** Metrics ndjson lines for sessions whose id starts with `prefix`. */
  metrics(prefix: string): any[] {
    const dir = path.join(this.home, '.supersurf', 'logs', 'sessions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.startsWith(`metrics-${prefix}`) && f.endsWith('.ndjson'))
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  }
}


// ───────────────────────── check registry ─────────────────────────

/** The long-lived environment most checks share: one daemon, one Chromium, two labelled pages. */
interface Shared { env: Env; pageA: Fixture; pageB: Fixture; boot: Proc }

interface Ctx { tree: Tree; shared: () => Promise<Shared>; label: string }
interface Check { id: string; tier: string; entry: string; solo: boolean; run: (c: Ctx) => Promise<Outcome> }
const CHECKS: Check[] = [];
/** `solo` checks build their own environment, so they run after the shared daemon (port 5555) is down. */
const reg = (id: string, tier: string, entry: string, run: (c: Ctx) => Promise<Outcome>, solo = false) => CHECKS.push({ id, tier, entry, solo, run });

/** Run `fn` with a fresh process under `name`; always disconnect and stop it. */
async function withProc<T>(env: Env, name: string, mode: 'script' | 'mcp', fn: (p: Proc) => Promise<T>, extraEnv: Record<string, string> = {}): Promise<T> {
  const p = env.proc(name, mode, extraEnv);
  try { await p.init(); return await fn(p); }
  finally { await p.call('disconnect', {}, 10_000).catch(() => {}); await p.stop(); }
}

// ───────────────────────── tier A: sessions ─────────────────────────

reg('3', 'A', 'One server serves many agents by `username`; duplicate, missing, unknown names refused', async ({ tree, shared }) => {
  const { env } = await shared();
  return withProc(env, 'c3a', 'script', async (p) => {
    const r1 = await p.connect('c3a');
    if (r1.isError) return fail(`first connect refused: ${J(r1.text)}`);
    const r2 = await p.connect('c3b');
    if (r2.isError) return fail(`second agent in the same process refused: ${J(r2.text)}`);
    if (r2.json?.already_connected) return fail(`second connect in the same process got already_connected (one session per process): ${J(r2.text)}`);
    const dup = await p.connect('c3a');
    const none = await p.call('browser_tabs', { action: 'list', username: undefined });
    const ghost = await p.call('browser_tabs', { action: 'list', username: 'c3-ghost' });
    await p.call('disconnect', { username: 'c3b' }).catch(() => {});
    const ok = /already in use/.test(dup.text) && /username required/.test(none.text) && /No live session for username "c3-ghost"/.test(ghost.text);
    const ev = `dup=${J(dup.text).slice(0, 90)} | missing=${J(none.text).slice(0, 70)} | unknown=${J(ghost.text).slice(0, 70)}`;
    return ok ? pass(ev) : fail(ev);
  });
});

reg('4', 'A', 'Every result carries `👤 you are <name>`, errors included', async ({ shared }) => {
  const { env, pageA } = await shared();
  return withProc(env, 'c4a', 'mcp', async (p) => {
    const c = await p.connect('c4a');
    const okR = await p.call('browser_tabs', { action: 'new', url: pageA.url + '/' });
    const errR = await p.call('browser_tabs', { action: 'attach', tabId: 987654321 });
    const mark = /you are c4a/;
    const ev = `ok-result=${mark.test(okR.text)} error-result(isError=${errR.isError})=${mark.test(errR.text)} connect=${mark.test(c.text)} :: ${J(errR.text).slice(0, 140)}`;
    return mark.test(okR.text) && mark.test(errR.text) && errR.isError ? pass(ev) : fail(ev);
  });
});

reg('6', 'A', 'Nameless `status` is health only and names nobody', async ({ shared }) => {
  const { env } = await shared();
  return withProc(env, 'c6-visible', 'script', async (p) => {
    await p.connect('c6-visible');
    const st = await p.call('status', { username: undefined });
    const text = st.text;
    const running = st.json?.daemon?.running === true;
    const leaked = /c6-visible/.test(text);
    const ev = `daemon.running=${running} leakedName=${leaked} :: ${J(text).slice(0, 220)}`;
    return running && !leaked ? pass(ev) : fail(ev);
  });
});

reg('5', 'A', '`disconnect` and idle expiry close created tabs and release attached tabs', async ({ tree }) => {
  const env = new Env(tree, { config: { agents: { idle_timeout_ms: 4000 } } });
  try {
    const f = await env.fixture(labelPage('i'));
    const boot = env.proc('c5-boot', 'script');
    await env.browserUp(boot);
    // (a) explicit disconnect closes the created tab and leaves the attached about:blank tab open
    const tag = 'c5d' + Date.now();
    const blanksBefore = (await env.livePages()).filter((t) => t.url === 'about:blank').length;
    const d = env.proc('c5d', 'script');
    await d.connect('c5d');
    await d.call('browser_tabs', { action: 'new', url: `${f.url}/?${tag}=1` });
    const list = await d.call('browser_tabs', { action: 'list' });
    const blank = (list.json?.tabs ?? []).find((t: any) => t.url === 'about:blank');
    if (blank) await d.call('browser_tabs', { action: 'attach', tabId: blank.id });
    const dr = await d.call('disconnect', {});
    await sleep(1500);
    const after = await env.livePages();
    const createdAlive = after.some((t) => t.url.includes(tag));
    const blanksAfter = after.filter((t) => t.url === 'about:blank').length;
    const aOk = !createdAlive && !!blank && blanksAfter >= blanksBefore;
    // (b) idle expiry (4s timeout): same outcome without a disconnect call
    const itag = 'c5i' + Date.now();
    const i = env.proc('c5i', 'script');
    await i.connect('c5i');
    await i.call('browser_tabs', { action: 'new', url: `${f.url}/?${itag}=1` });
    const alive0 = (await env.livePages()).some((t) => t.url.includes(itag));
    await sleep(14_000);
    const alive1 = (await env.livePages()).some((t) => t.url.includes(itag));
    const bOk = alive0 && !alive1;
    const ev = `disconnect: createdTabAlive=${createdAlive}, attached blank tabs ${blanksBefore}->${blanksAfter} (${J(dr.text).slice(0, 70)}) | idle 4s: tab alive before=${alive0} after 14s=${alive1}`;
    return aOk && bOk ? pass(ev) : fail(ev);
  } finally { await env.down(); }
}, true);

reg('7', 'A', '`playbooks history` is per agent', async ({ shared }) => {
  const { env, pageA } = await shared();
  return withProc(env, 'c7a', 'script', async (p) => {
    const c1 = await p.connect('c7a');
    const c2 = await p.connect('c7b');
    const note = c2.json?.already_connected ? ' (second connect returned already_connected: one trail per process)' : '';
    await p.call('browser_tabs', { action: 'new', url: `${pageA.url}/?c7=1`, username: 'c7a' });
    await p.call('browser_evaluate', { purpose: 'c7-marker-purpose', function: '() => document.title', username: 'c7a' });
    await p.call('browser_evaluate', { purpose: 'c7-marker-purpose', expression: 'document.title', username: 'c7a' });
    const hA = await p.call('playbooks', { action: 'history', username: 'c7a' });
    const hB = await p.call('playbooks', { action: 'history', username: 'c7b' });
    const ownSeen = /c7=1|evaluate|browser_tabs|tabs/i.test(hA.text);
    const leak = /c7=1|evaluate|browser_tabs/i.test(hB.text);
    await p.call('disconnect', { username: 'c7b' }).catch(() => {});
    void c1;
    const ev = `own history non-empty=${ownSeen}; other agent's history shows first agent's actions=${leak}${note} :: B=${J(hB.text).slice(0, 160)}`;
    return ownSeen && !leak ? pass(ev) : fail(ev);
  });
});

reg('22', 'A', 'Session-conflict error names the session holding the id', async ({ shared }) => {
  const { env } = await shared();
  const a = env.proc('c22', 'script');
  const b = env.proc('c22-second', 'script');
  try {
    const ca = await a.connect('c22');
    if (ca.isError) return fail(`holder could not connect: ${J(ca.text)}`);
    const cb = await b.connect('c22');
    const txt = cb.text;
    const ev = `second connect (same id, other process): ${J(txt).slice(0, 260)}`;
    // "names the session holding the id": the id itself plus who/what holds it.
    return cb.isError && /already in use/i.test(txt) && /c22/.test(txt) && /(held by|by a live|session|agent|pid|process)/i.test(txt.replace(/Session ID already in use/i, '')) ? pass(ev) : fail(ev);
  } finally { await a.call('disconnect', {}, 8000).catch(() => {}); await a.stop(); await b.stop(); }
});

reg('23', 'A', '`disconnect` reports a release', async ({ shared }) => {
  const { env } = await shared();
  const a = env.proc('c23a', 'script');
  const b = env.proc('c23b', 'script');
  try {
    await a.connect('c23a'); await b.connect('c23b');
    const d = await b.call('disconnect', {});
    const ev = `disconnect result: ${J(d.text).slice(0, 260)}`;
    return /released/i.test(d.text) && /other agent/i.test(d.text) ? pass(ev) : fail(ev);
  } finally { await a.call('disconnect', {}, 8000).catch(() => {}); await a.stop(); await b.stop(); }
});

// ───────────────────────── tier B: isolation between concurrent sessions ─────────────────────────

/** A fixture whose click mutates the DOM (so page_diffing, if on, has something to report). */
const mutatePage = (env: Env) => env.once('mutatePage', () => env.fixture(serve({
  '/': '<!doctype html><title>MUT</title><button id="go" onclick="var p=document.createElement(\'p\');p.textContent=\'added \'+Date.now();document.body.appendChild(p)">Go</button>',
})));

const clickAction = (selector: string, extra: any = {}) => ({ type: 'click', selector, name: 'bench_target', purpose: 'benchmark click', ...extra });

/**
 * Scenario for checks 16 and 17. A playbook with `meta.experiments: true` holds its own session open for
 * ~6s while agent A (MCP mode, so page-diff text would be visible) clicks a DOM-mutating button.
 */
async function flagLeakScenario(shared: Shared) {
  const { env, pageB } = shared;
  return env.once('flagLeak', async () => {
    const dir = path.join(env.home, '.supersurf', 'playbooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bench_flags.playbook.js'),
      `export const meta = { description: 'bench: hold an experiments-enabled session open', experiments: true };\n` +
      `export default async function ({ supersurf }) {\n  await supersurf.goto('${pageB.url}/');\n  await supersurf.wait(6000);\n  return 'done';\n}\n`);
    const m = await mutatePage(env);
    const a = env.proc('c16a', 'mcp');
    await a.init();
    await a.connect('c16a');
    await a.call('browser_tabs', { action: 'new', url: m.url + '/' });
    const run = a.call('playbooks', { action: 'run', name: 'bench_flags' }, 90_000);
    await sleep(3500); // the run's session is now inside wait(6000)
    const click = await a.call('browser_interact', { actions: [clickAction('#go')] });
    const runRes = await run;
    await sleep(500);
    const runLines = env.metrics('playbook-');
    return { click, runRes, runSessionHadFlag: runLines.some((l) => l.experiments?.page_diffing === true), aLines: env.metrics('c16a-') };
  });
}

reg('16', 'B', 'An experiment flag enabled for one session does not leak into a concurrent session', async ({ shared }) => {
  const sh = await shared();
  const r = await flagLeakScenario(sh);
  const leaked = /Page diff/i.test(r.click.text);
  const ev = `run session had page_diffing on=${r.runSessionHadFlag}; A's click during the run showed page diff=${leaked} :: ${J(r.click.text).slice(0, 120)}`;
  if (!r.runSessionHadFlag) return skip(`positive control failed (run session never had page_diffing on): ${J(r.runRes.text).slice(0, 160)}`);
  return !leaked ? pass(ev) : fail(ev);
});

reg('17', 'B', 'Usage-metrics `experiments` field reports only the caller\'s flags', async ({ shared }) => {
  const sh = await shared();
  const r = await flagLeakScenario(sh);
  const bad = r.aLines.filter((l: any) => l.experiments?.page_diffing === true).map((l: any) => l.tool);
  const ev = `run session logged page_diffing=${r.runSessionHadFlag}; A's ${r.aLines.length} metrics lines with page_diffing=true: ${bad.length}${bad.length ? ' (' + bad.join(',') + ')' : ''}`;
  if (!r.runSessionHadFlag) return skip('positive control failed: run session never logged page_diffing=true');
  if (r.aLines.length === 0) return fail('A wrote no usage-metrics lines');
  return bad.length === 0 ? pass(ev) : fail(ev);
});

reg('18', 'B', '`browser_network_requests` reads only the calling session\'s own tab', async ({ shared }) => {
  const { env, pageA, pageB } = await shared();
  const a = env.proc('c18a', 'script'); const b = env.proc('c18b', 'script');
  try {
    await a.connect('c18a'); await b.connect('c18b');
    await a.call('browser_tabs', { action: 'new', url: pageA.url + '/?c18=1' });
    await b.call('browser_tabs', { action: 'new', url: pageB.url + '/?c18=1' });
    await sleep(2000);
    const na = await a.call('browser_network_requests', {});
    const nb = await b.call('browser_network_requests', {});
    const urls = (r: Reply) => (r.json?.requests ?? []).map((x: any) => String(x.url));
    const ua = urls(na), ub = urls(nb);
    const ownA = ua.some((u: string) => u.includes(`:${pageA.port}`)), ownB = ub.some((u: string) => u.includes(`:${pageB.port}`));
    const aSeesB = ua.filter((u: string) => u.includes(`:${pageB.port}`)).length, bSeesA = ub.filter((u: string) => u.includes(`:${pageA.port}`)).length;
    const ev = `A: ${ua.length} reqs (own=${ownA}, sees B's=${aSeesB}); B: ${ub.length} reqs (own=${ownB}, sees A's=${bSeesA})`;
    if (!ownA || !ownB) return fail(`positive control failed - a session missed its own traffic. ${ev}`);
    return aSeesB === 0 && bSeesA === 0 ? pass(ev) : fail(ev);
  } finally { for (const p of [a, b]) { await p.call('disconnect', {}, 8000).catch(() => {}); await p.stop(); } }
});

reg('19', 'B', 'A session with no tab cannot read or wipe another session\'s network or console', async ({ shared }) => {
  const { env } = await shared();
  const loud = await env.once('loudPage', () => env.fixture(serve({
    '/': '<!doctype html><title>LOUD</title><script src="/loud.js"></script><script>setInterval(function(){console.log("c19-console-secret")},400)</script>',
    '/loud.js': 'window.__loud=1;',
  })));
  const a = env.proc('c19a', 'script'); const c = env.proc('c19c', 'script');
  try {
    await a.connect('c19a'); await c.connect('c19c');
    await a.call('browser_tabs', { action: 'new', url: loud.url + '/' });
    await sleep(2000);
    const ownNet = JSON.stringify((await a.call('browser_network_requests', {})).json ?? {});
    await sleep(1500);
    const ownCon = (await a.call('browser_console_messages', {})).text;
    if (!ownNet.includes('loud.js') || !ownCon.includes('c19-console-secret')) return fail(`positive control failed: A net has loud.js=${ownNet.includes('loud.js')}, console has secret=${ownCon.includes('c19-console-secret')} :: ${J(ownCon).slice(0, 200)}`);
    const cNet = await c.call('browser_network_requests', {});
    const cCon = await c.call('browser_console_messages', {});
    const cClear = await c.call('browser_network_requests', { action: 'clear' });
    const after = JSON.stringify((await a.call('browser_network_requests', {})).json ?? {});
    const readLeak = cNet.text.includes('loud.js') || cCon.text.includes('c19-console-secret');
    const wiped = !after.includes('loud.js');
    const ev = `tabless C: net read leaked=${cNet.text.includes('loud.js')}, console read leaked=${cCon.text.includes('c19-console-secret')}, wiped A's log=${wiped} :: C net=${J(cNet.text).slice(0, 110)}`;
    void cClear;
    return !readLeak && !wiped ? pass(ev) : fail(ev);
  } finally { for (const p of [a, c]) { await p.call('disconnect', {}, 8000).catch(() => {}); await p.stop(); } }
});

reg('32', 'B', 'Each MCP session tracks its own attached tab', async ({ shared }) => {
  const { env, pageA, pageB } = await shared();
  const a = env.proc('c32a', 'script'); const b = env.proc('c32b', 'script');
  try {
    await a.connect('c32a'); await b.connect('c32b');
    await a.call('browser_tabs', { action: 'new', url: pageA.url + '/?c32=1' });
    await b.call('browser_tabs', { action: 'new', url: pageB.url + '/?c32=1' });
    // B acts last, so a single global pointer would now sit on B's tab. A must still read PAGE-A.
    const titleOf = async (p: Proc) => String((await p.call('browser_evaluate', { purpose: 'bench title', expression: 'document.title' })).text);
    const ta = await titleOf(a), tb = await titleOf(b);
    await b.call('browser_tabs', { action: 'new', url: pageB.url + '/?c32=2' });
    const ta2 = await titleOf(a);
    // The list's `attached` flag is the extension's view of the pointer: A's list must flag A's own tab, never B's.
    const la = await a.call('browser_tabs', { action: 'list' });
    const flagged = (la.json?.tabs ?? []).filter((t: any) => t.attached).map((t: any) => String(t.url));
    const flagOk = flagged.some((u: string) => u.includes(`:${pageA.port}`)) && !flagged.some((u: string) => u.includes(`:${pageB.port}`));
    // B closes the only tab it owns; with no tab of its own it must not silently fall onto A's.
    const lb = await b.call('browser_tabs', { action: 'list' });
    const bTabs = (lb.json?.tabs ?? []).filter((t: any) => String(t.url).includes(`:${pageB.port}`));
    for (const t of [...bTabs].sort((x: any, y: any) => y.index - x.index)) await b.call('browser_tabs', { action: 'close', index: t.index });
    const tb2 = await titleOf(b);
    const ev = `A's list flags attached=${J(flagged)}; A reads: ${J(ta).slice(0, 40)} / after B opened another: ${J(ta2).slice(0, 40)}; B reads: ${J(tb).slice(0, 40)}; B after closing its tabs: ${J(tb2).slice(0, 100)}`;
    return /PAGE-A/.test(ta) && /PAGE-A/.test(ta2) && /PAGE-B/.test(tb) && !/PAGE-A/.test(tb2) && flagOk ? pass(ev) : fail(ev);
  } finally { for (const p of [a, b]) { await p.call('disconnect', {}, 8000).catch(() => {}); await p.stop(); } }
});

reg('33', 'B', 'CDP attaches per tab: one session\'s screenshot does not kill another\'s network capture', async ({ shared }) => {
  const { env, pageA, pageB } = await shared();
  const a = env.proc('c33a', 'script'); const b = env.proc('c33b', 'script');
  try {
    await a.connect('c33a'); await b.connect('c33b');
    await a.call('browser_tabs', { action: 'new', url: pageA.url + '/' });
    await b.call('browser_tabs', { action: 'new', url: pageB.url + '/' });
    await sleep(1500);
    await b.call('browser_take_screenshot', {});
    await a.call('browser_navigate', { action: 'url', url: pageA.url + '/?late=1' });
    await sleep(1500);
    const net = await a.call('browser_network_requests', {});
    const got = (net.json?.requests ?? []).some((r: any) => String(r.url).includes('a-late.js'));
    const ev = `A's request made after B's screenshot captured=${got} (${(net.json?.requests ?? []).length} requests in A's log)`;
    return got ? pass(ev) : fail(ev);
  } finally { for (const p of [a, b]) { await p.call('disconnect', {}, 8000).catch(() => {}); await p.stop(); } }
});

reg('34', 'B', 'Native dialogs are held per tab and block only the session on that tab', async ({ shared }) => {
  const { env, pageB } = await shared();
  const dlg = await env.once('dialogPage', () => env.fixture(serve({
    '/': '<!doctype html><title>DLG</title><script>setTimeout(function(){alert("c34-held")},3000)</script>',
  })));
  const a = env.proc('c34a', 'script'); const b = env.proc('c34b', 'script');
  try {
    await a.connect('c34a'); await b.connect('c34b');
    await b.call('browser_tabs', { action: 'new', url: pageB.url + '/' });
    await a.call('browser_tabs', { action: 'new', url: dlg.url + '/' });
    await a.call('browser_take_screenshot', {}); // attaches the debugger to A's tab; CDP is what holds a dialog open
    await sleep(4500); // A's alert() is now pending
    const view = await a.call('browser_handle_dialog', { action: 'view' }, 15_000).catch((e) => ({ text: 'ERR ' + e.message } as any));
    const t = await b.call('browser_evaluate', { purpose: 'bench title', expression: 'document.title' }, 20_000).catch((e) => ({ text: 'ERR ' + e.message, isError: true } as any));
    await a.call('browser_handle_dialog', { action: 'accept' }, 15_000).catch(() => {});
    const held = /c34-held/.test(view.text);
    const ev = `A's dialog held=${held}; B (own tab) evaluate meanwhile: ${J(t.text).slice(0, 180)}`;
    if (!held) return fail(`positive control failed - A's alert was never held: ${J(view.text).slice(0, 160)}`);
    return /PAGE-B/.test(t.text) ? pass(ev) : fail(ev);
  } finally { for (const p of [a, b]) { await p.call('disconnect', {}, 8000).catch(() => {}); await p.stop(); } }
});

// ───────────────────────── tier C: element-miss hints ─────────────────────────

/** Run `fn` against a fresh MCP-mode process (raw text, tips and hints visible), connected under `name`. */
async function withMcp<T>(env: Env, name: string, fn: (p: Proc) => Promise<T>): Promise<T> {
  return withProc(env, name, 'mcp', async (p) => {
    const c = await p.connect();
    if (c.isError) throw new Error(`connect refused: ${oneLine(c.text, 200)}`);
    return fn(p);
  });
}

/**
 * One hostile page: no ids, no classes on the targets, a decoy logo link FIRST in the document, repeated
 * link text. Every clickable reports its own name to /hit, so identity is "which beacon fired", never "does
 * the selector look right".
 */
const hostile = (env: Env) => env.once('hostile', () => env.fixture(serve({
  '/': `<!doctype html><title>HOSTILE</title>
<style>body{margin:8px;font:14px sans-serif}a,span,button{display:block;width:260px;height:24px;margin:2px 0;cursor:pointer}ul{list-style:none;padding:0;margin:0}</style>
<script>function b(p){new Image().src='/hit?p='+encodeURIComponent(p)}</script>
<a href="javascript:void(0)" onclick="b('logo')"><img width="20" height="20" alt=""></a>
<ul>
<li><a href="javascript:void(0)" onclick="b('Alpha item')">Alpha item</a></li>
<li><a href="javascript:void(0)" onclick="b('Beta item')">Beta item</a></li>
<li><a href="javascript:void(0)" onclick="b('Gamma item')">Gamma item</a></li>
</ul>
<a href="javascript:void(0)" onclick="b('crash')">Fix crash #1234</a>
<span class="promo-action promo-dismiss-link promo-left" onclick="b('promo')">Dismiss promo</span>
<span class="md:flex w-1/2" onclick="b('tw')">Tailwind text</span>
<button onclick="b('gotit')">Got it</button>
<button id="submit-order-btn" onclick="b('order')">Submit order</button>
<input id="email-field" aria-label="Email address">
<input placeholder="First field"><input placeholder="Second field">`,
})));

interface Cand { handle?: string; caption?: string; selector: string; tag?: string }

/** Parse a "Did you mean?" block: 5.0.0's `@handle · "caption" · tag · …` + selector line, or 4.0.0's `sel` + `Text:` lines. */
function parseHints(text: string): Cand[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /Did you mean\?/.test(l));
  if (start < 0) return [];
  const out: Cand[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s+\d+\. (.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[1].startsWith('`')) {
      const sel = /`([^`]+)`/.exec(m[1])?.[1] ?? '';
      const cap = /^\s+Text: "(.*)"$/.exec(lines[i + 1] ?? '')?.[1];
      out.push({ selector: sel, caption: cap });
    } else {
      const parts = m[1].split(' · ');
      const handle = parts[0].startsWith('@') ? parts.shift()!.slice(1) : undefined;
      const caption = parts[0]?.startsWith('"') ? parts.shift()!.slice(1, -1) : undefined;
      out.push({ handle, caption, tag: parts[0], selector: (lines[i + 1] ?? '').trim() });
    }
  }
  return out;
}

/** Beacons fired by a click: at least one, and every one is `name` (a click may legitimately report its beacon twice). */
const onlyBeacon = (hits: string[], name: string) => hits.length > 0 && hits.every((h) => h === name);

const click = (selector: string) => ({ actions: [{ type: 'click', selector }] });

/** Click `selector` (a pasted handle or selector) and return which beacon(s) fired, plus the click's own verdict. */
async function clickBeacon(p: Proc, fx: Fixture, selector: string): Promise<{ hits: string[]; text: string; isError: boolean }> {
  fx.hits.length = 0;
  const r = await p.call('browser_interact', click(selector));
  await sleep(350);
  return { hits: [...fx.hits], text: r.text, isError: r.isError };
}

async function openHostile(env: Env, p: Proc): Promise<Fixture> {
  const fx = await hostile(env);
  await p.call('browser_tabs', { action: 'new', url: fx.url + '/' });
  await sleep(800);
  return fx;
}

reg('24', 'C', 'An ephemeral `@handle` from the "Did you mean?" hint is never bound to the wrong element', async ({ shared }) => {
  const { env } = await shared();
  return withMcp(env, 'c24', async (p) => {
    const fx = await openHostile(env, p);
    const miss = await p.call('browser_interact', click('button:has-text("item")'));
    const cands = parseHints(miss.text).filter((c) => c.caption);
    if (cands.length < 3) return fail(`expected 3 captioned candidates, got ${cands.length}: ${J(miss.text).slice(0, 220)}`);
    const rows: string[] = [];
    let ok = true;
    for (const c of cands.slice(0, 3)) {
      const paste = c.handle ? `@${c.handle}` : c.selector;
      const r = await clickBeacon(p, fx, paste);
      const good = onlyBeacon(r.hits, c.caption!);
      ok &&= good;
      rows.push(`${paste} ("${c.caption}") -> ${r.hits.join(',') || 'no beacon'}`);
    }
    return (ok ? pass : fail)(rows.join(' | '));
  });
});

reg('25', 'C', 'A `#<digit>` inside `:has-text("…")` is not rewritten as a CSS id', async ({ shared }) => {
  const { env } = await shared();
  return withMcp(env, 'c25', async (p) => {
    const fx = await openHostile(env, p);
    const r = await clickBeacon(p, fx, 'a:has-text("Fix crash #1234")');
    const ev = `click a:has-text("Fix crash #1234") -> beacons [${r.hits.join(',')}] :: ${J(r.text).slice(0, 150)}`;
    return onlyBeacon(r.hits, 'crash') ? pass(ev) : fail(ev);
  });
});

reg('26', 'C', '`browser_lookup` suggestions re-resolve to the element they describe', async ({ shared }) => {
  const { env } = await shared();
  return withMcp(env, 'c26', async (p) => {
    const fx = await openHostile(env, p);
    const rows: string[] = [];
    let ok = true;
    for (const text of ['Beta item', 'Gamma item']) {
      const lk = await p.call('browser_lookup', { text });
      const sel = /\*\*(.+?)\*\*/.exec(lk.text)?.[1];
      if (!sel) { ok = false; rows.push(`lookup "${text}": no selector :: ${J(lk.text).slice(0, 100)}`); continue; }
      const r = await clickBeacon(p, fx, sel);
      const good = onlyBeacon(r.hits, text);
      ok &&= good;
      rows.push(`lookup "${text}" suggests ${sel} -> ${r.hits.join(',') || 'no beacon'}`);
    }
    return (ok ? pass : fail)(rows.join(' | '));
  });
});

reg('27', 'C', 'The "Did you mean?" selector is valid CSS (multi-class and Tailwind tokens)', async ({ shared }) => {
  const { env } = await shared();
  return withMcp(env, 'c27', async (p) => {
    const fx = await openHostile(env, p);
    const rows: string[] = [];
    let ok = true;
    for (const [phrase, beacon] of [['Dismiss promo', 'promo'], ['Tailwind text', 'tw']]) {
      const miss = await p.call('browser_interact', click(`button:has-text("${phrase}")`));
      const c = parseHints(miss.text).find((x) => x.caption === phrase);
      if (!c) { ok = false; rows.push(`"${phrase}": no candidate :: ${J(miss.text).slice(0, 100)}`); continue; }
      let valid = 'n/a (has-text form)';
      if (!c.selector.includes(':has-text(')) {
        const v = await p.call('browser_evaluate', { purpose: 'bench css validity', expression: `(() => { try { return String(document.querySelectorAll(${JSON.stringify(c.selector)}).length); } catch (e) { return 'THROWS'; } })()` });
        valid = /\b1\b/.test(v.text) && !/THROWS/.test(v.text) ? 'valid, 1 match' : `INVALID (${J(v.text).slice(0, 40)})`;
      }
      const r = await clickBeacon(p, fx, c.selector);
      const good = !valid.startsWith('INVALID') && onlyBeacon(r.hits, beacon);
      ok &&= good;
      rows.push(`"${phrase}" printed ${c.selector} [${valid}] -> ${r.hits.join(',') || 'no beacon'}`);
    }
    return (ok ? pass : fail)(rows.join(' | '));
  });
});

reg('30', 'C', 'Every selector-resolving tool suggests candidates on a plain-CSS miss', async ({ shared }) => {
  const { env } = await shared();
  return withMcp(env, 'c30', async (p) => {
    await openHostile(env, p);
    const probes: [string, string, any][] = [
      ['interact click', 'browser_interact', click('#submit-order')],
      ['interact type', 'browser_interact', { actions: [{ type: 'type', selector: '#email-address', text: 'x' }] }],
      ['interact wait', 'browser_interact', { actions: [{ type: 'wait', selector: '#submit-order', timeout: 1500 }] }],
      ['fill_form', 'browser_fill_form', { fields: [{ selector: '#email-address', value: 'x' }] }],
    ];
    const rows: string[] = [];
    let ok = true;
    for (const [label, tool, args] of probes) {
      const r = await p.call(tool, args, 30_000);
      const has = /Did you mean\?/.test(r.text);
      ok &&= has;
      rows.push(`${label}: ${has ? 'hint' : 'NO hint'}`);
    }
    return (ok ? pass : fail)(rows.join(', '));
  });
});

reg('31', 'C', 'The element-miss hint offers a pasteable `@handle` per candidate with readable text', async ({ shared }) => {
  const { env } = await shared();
  return withMcp(env, 'c31', async (p) => {
    const fx = await openHostile(env, p);
    const miss = await p.call('browser_interact', click('div:has-text("Got it")'));
    const c = parseHints(miss.text).find((x) => x.caption === 'Got it');
    if (!c) return fail(`no "Got it" candidate :: ${J(miss.text).slice(0, 200)}`);
    if (!c.handle) return fail(`candidate "Got it" carries no @handle (selector only: ${c.selector})`);
    const r = await clickBeacon(p, fx, `@${c.handle}`);
    const ev = `hint shows @${c.handle}; pasting it -> beacons [${r.hits.join(',')}]`;
    return onlyBeacon(r.hits, 'gotit') ? pass(ev) : fail(ev);
  });
});

reg('HN', 'C', 'Live site: hint handles on news.ycombinator.com each open a different page (they all used to click the logo)', async ({ shared }) => {
  const { env } = await shared();
  return withMcp(env, 'chn', async (p) => {
    const t = await p.call('browser_tabs', { action: 'new', url: 'https://news.ycombinator.com/' }, 60_000);
    await sleep(2500);
    const title = await p.call('browser_evaluate', { purpose: 'bench title', expression: 'document.title' });
    if (t.isError || !/Hacker News/i.test(title.text)) return skip(`news.ycombinator.com not reachable from Chromium: ${J(title.text).slice(0, 120)}`);
    const miss = await p.call('browser_interact', click('button:has-text("comments")'));
    const cands = parseHints(miss.text).filter((c) => c.caption).slice(0, 3);
    if (cands.length < 3) return fail(`expected 3 candidates, got ${cands.length}: ${J(miss.text).slice(0, 200)}`);
    const urls: string[] = [];
    const clicks: string[] = [];
    for (const c of cands) {
      const cr = await p.call('browser_interact', click(c.handle ? `@${c.handle}` : c.selector));
      clicks.push(J(cr.text).slice(0, 90));
      await sleep(2500);
      const u = await p.call('browser_evaluate', { purpose: 'bench location', expression: 'location.href' });
      const body = u.text.split('---').pop() || u.text; // the status header carries the pre-click tab URL
      urls.push(/https?:\/\/[^\s"']+/.exec(body)?.[0] ?? J(body));
      await p.call('browser_navigate', { action: 'url', url: 'https://news.ycombinator.com/' });
      await sleep(2000);
    }
    const distinct = new Set(urls).size;
    const ev = `${cands.map((c) => c.handle ? '@' + c.handle : c.selector).join(', ')} -> ${urls.join(' , ')}`;
    return distinct === 3 && urls.every((u) => !/^https:\/\/news\.ycombinator\.com\/?$/.test(u)) ? pass(ev) : fail(`${distinct} distinct page(s): ${ev} :: clicks ${clicks.join(' | ')}`);
  });
});

// ───────────────────────── tier D: tips ─────────────────────────

/** Four navigation-tip triggers, run once in MCP mode (tips only exist there). The shared HOME has no ~/.claude, so the plugin is "not installed". */
const tipScenario = (sh: Shared) => sh.env.once('tips', async () => {
  const { env } = sh;
  const p = env.proc('c13', 'mcp');
  await p.init();
  await p.connect();
  await openHostile(env, p);
  const miss = (selector: string) => p.call('browser_interact', click(selector));
  return {
    pw: await miss('text=Sign in'),
    br: await miss('#answers[0]'),
    wt: await miss('button:has-text("Alpha item")'),
    cap: await p.call('browser_evaluate', { purpose: 'check whether a captcha badge blocks the page', expression: 'document.title' }),
  };
});

reg('13', 'D', 'Four new navigation tips (Playwright syntax, unescaped id bracket, :has-text wrong tag, CAPTCHA badge)', async ({ shared }) => {
  const r = await tipScenario(await shared());
  const got = {
    playwright: /CSS, not Playwright/.test(r.pw.text),
    idBracket: /must be escaped/.test(r.br.text),
    wrongTag: /different element type/.test(r.wt.text),
    captcha: /CAPTCHA badge/.test(r.cap.text),
  };
  const ev = `tips seen: ${Object.entries(got).map(([k, v]) => `${k}=${v}`).join(', ')}`;
  return Object.values(got).every(Boolean) ? pass(ev) : fail(`${ev} :: Playwright-selector reply tail: ${J(r.pw.text).slice(-140)}`);
});

reg('14', 'D', 'Tips know about the SuperSurf plugin (install hint when absent)', async ({ shared }) => {
  const r = await tipScenario(await shared());
  const hint = (t: string) => /\/plugin marketplace add LiquidBuiltIt\/Supersurf/.test(t) && /\/plugin install supersurf@supersurf/.test(t);
  const ev = `plugin NOT installed: install hint on Playwright-selector tip=${hint(r.pw.text)}, on wrong-tag tip=${hint(r.wt.text)}; plugin installed variant: SKIP (live pass)`;
  return hint(r.pw.text) && hint(r.wt.text) ? pass(ev) : fail(`${ev} :: ${J(r.pw.text).slice(-160)}`);
});

// ───────────────────────── tier F: secure_eval ─────────────────────────

const isBlocked = (r: Reply) => r.isError && /block|secure.?eval|not allowed|forbidden|denied|unsafe/i.test(r.text);

reg('1', 'F', 'secure_eval blocks `ownerDocument`, `defaultView`, `contentWindow` and `contentDocument`', async ({ shared }) => {
  const { env, pageA } = await shared();
  return withProc(env, 'c1', 'script', async (p) => {
    await p.connect();
    await p.call('browser_tabs', { action: 'new', url: pageA.url + '/' });
    const ev = (expression: string) => p.call('browser_evaluate', { purpose: 'bench secure_eval probe', expression });
    const control = await ev('document.title');
    if (control.isError) return fail(`positive control failed - plain read blocked: ${J(control.text).slice(0, 120)}`);
    const probes: [string, string][] = [
      ['ownerDocument', 'document.body.ownerDocument.title'],
      ['defaultView', 'document.defaultView.location.href'],
      ['contentWindow', "document.createElement('iframe').contentWindow"],
      ['contentDocument', "document.createElement('iframe').contentDocument"],
    ];
    const rows: string[] = [];
    let ok = true;
    for (const [name, expr] of probes) {
      const r = await ev(expr);
      const blocked = isBlocked(r);
      ok &&= blocked;
      rows.push(`${name}: ${blocked ? 'blocked' : 'ALLOWED -> ' + J(r.text).slice(0, 50)}`);
    }
    return (ok ? pass : fail)(rows.join(', '));
  });
});

reg('2', 'F', 'The block message and the tool description do not name how to disable secure_eval', async ({ shared }) => {
  const { env, pageA } = await shared();
  return withMcp(env, 'c2', async (p) => {
    await p.call('browser_tabs', { action: 'new', url: pageA.url + '/' });
    let block = '';
    for (const expr of ["eval('1')", "new Function('return 1')()", 'document.cookie']) {
      const r = await p.call('browser_evaluate', { purpose: 'bench secure_eval probe', expression: expr });
      if (isBlocked(r)) { block = r.text; break; }
    }
    const desc: string = (await p.listTools()).find((t: any) => t.name === 'browser_evaluate')?.description ?? '';
    const NAMES_FIX = /SUPERSURF_DISABLE_SECURE_EVAL|--disable-secure-eval|opt out|disable/i;
    const inBlock = block ? NAMES_FIX.test(block) : null;
    const inDesc = NAMES_FIX.test(desc);
    const ev = `block message ${block ? (inBlock ? 'names the switch' : 'is silent about it') : 'not produced'}; tool description ${inDesc ? 'names the switch (' + J(/[^.]*(?:disable|opt out)[^.]*\./i.exec(desc)?.[0] ?? '').slice(0, 110) + ')' : 'is silent about it'}`;
    if (!block) return fail(`no probe was blocked, so the message could not be read. ${ev}`);
    return !inBlock && !inDesc ? pass(ev) : fail(ev);
  });
});

reg('20', 'E', 'The `mouse_humanization` idle-drift alarm stops when no session is drifting', async () =>
  skip('extension-internal (a chrome.alarms reschedule inside the service worker); covered by extension unit tests only'));

// ───────────────────────── static and installer checks ─────────────────────────

const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** PATH without any directory that holds a `claude` binary: the real CLI must never be reachable. */
const safePath = () => (process.env.PATH || '').split(':').filter((d) => d && !fs.existsSync(path.join(d, 'claude'))).join(':');

/** Shell shims for the installer: a fake curl (writes a runnable >1 MB "binary"), node/npx pass-throughs, an optional fake claude. */
function mkShims(dir: string, o: { nodeVersion?: string; claude?: boolean }): string {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  const w = (n: string, body: string) => fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
  w('curl', `echo "curl $*" >> "${log}"\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\n[ -n "$out" ] || exit 22\nprintf '#!/bin/sh\\nexit 0\\n' > "$out"\nhead -c 1100000 /dev/zero | tr '\\0' '#' >> "$out"`);
  w('node', (o.nodeVersion ? `[ "$1" = "--version" ] && { echo ${o.nodeVersion}; exit 0; }\n` : '') + `exec "${process.execPath}" "$@"`);
  w('npx', `exec "${path.join(path.dirname(process.execPath), 'npx')}" "$@"`);
  if (o.claude) w('claude', `echo "claude $*" >> "${log}"\ncase "$1" in --help) echo "  mcp      Configure MCP servers"; echo "  plugin   Manage plugins";; esac\nexit 0`);
  return log;
}

/** Run `<tree>/docs/install.sh` in a throwaway HOME. */
function runInstaller(tree: Tree, args: string[], o: { nodeVersion?: string; claude?: boolean; realTools?: boolean; srcUrl?: string; timeoutMs?: number } = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-inst-'));
  const home = path.join(t, 'home');
  fs.mkdirSync(home);
  const shims = path.join(t, 'shims');
  const log = mkShims(shims, o);
  const env: Record<string, string> = {
    HOME: home, TERM: 'dumb', NO_COLOR: '1',
    PATH: o.realTools ? safePath() : `${shims}:/usr/bin:/bin`,
    SUPERSURF_SRC_DIR: path.join(t, 'src'),
  };
  if (o.srcUrl) env.SUPERSURF_SRC_URL = o.srcUrl;
  const r = spawnSync('sh', [path.join(tree.root, 'docs', 'install.sh'), ...args, '--dir', path.join(t, 'bin')], {
    env, encoding: 'utf8', timeout: o.timeoutMs ?? 60_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    t, status: r.status, out: stripAnsi(`${r.stdout || ''}${r.stderr || ''}`),
    calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
    done: () => fs.rmSync(t, { recursive: true, force: true }),
  };
}

reg('8', 'G', 'The restart command printed on failure is `npx supersurf-daemon@latest restart`', async ({ tree }) => {
  const reg_ = require(path.join(tree.root, 'daemon', 'dist', 'profiles', 'registration-page.js'));
  const html: string = reg_.registrationHtml('bench');
  const BAD = 'npx supersurf daemon restart';
  const GOOD = 'npx supersurf-daemon@latest restart';
  const stale: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.js$/.test(e.name) && fs.readFileSync(f, 'utf8').includes(BAD)) stale.push(path.relative(tree.root, f));
    }
  };
  for (const d of ['daemon/dist', 'server/dist', 'shared/dist']) walk(path.join(tree.root, d));
  const regOk = html.includes(GOOD) && !html.includes(BAD);
  const ev = `registration page prints ${html.includes(GOOD) ? GOOD : html.includes(BAD) ? BAD : '(no restart command)'}; built files still carrying "${BAD}": ${stale.length ? stale.join(', ') : 'none'}`;
  return regOk && stale.length === 0 ? pass(ev) : fail(ev);
});

reg('9', 'G', '`install.sh --latest` installs dependencies on a fresh clone', async ({ tree }) => {
  const r = runInstaller(tree, ['--yes', '--latest'], { realTools: true, srcUrl: tree.root, timeoutMs: 240_000 });
  try {
    const tail = J(r.out.split('\n').filter(Boolean).slice(-3).join(' | ')).slice(0, 200);
    const installedDeps = fs.existsSync(path.join(r.t, 'src', 'node_modules'));
    const ev = `exit ${r.status}; node_modules in clone=${installedDeps}; shim=${fs.existsSync(path.join(r.t, 'bin', 'supersurf'))} :: ${tail}`;
    return r.status === 0 && installedDeps ? pass(ev) : fail(ev);
  } finally { r.done(); }
});

reg('10', 'G', 'The installer refuses a Node older than 18 before downloading anything', async ({ tree }) => {
  const r = runInstaller(tree, ['--yes'], { nodeVersion: 'v16.20.0' });
  try {
    const refused = /Node\.js 18 or newer, found v16\.20\.0/.test(r.out);
    const downloaded = /curl /.test(r.calls);
    const ev = `exit ${r.status}; refused with a version message=${refused}; download attempted=${downloaded} :: ${J(r.out.split('\n').filter(Boolean).slice(-2).join(' | ')).slice(0, 170)}`;
    return refused && r.status !== 0 && !downloaded ? pass(ev) : fail(ev);
  } finally { r.done(); }
});

reg('11', 'G', '`supersurf-mcp` pins the exact daemon version released with it', async ({ tree }) => {
  const pin: string = readJson(path.join(tree.root, 'server', 'package.json')).dependencies?.['supersurf-daemon'] ?? '(none)';
  const daemonVer: string = readJson(path.join(tree.root, 'daemon', 'package.json')).version;
  const exact = /^\d+\.\d+\.\d+$/.test(pin);
  const resolved = tree.registryDaemon ? `; npm install resolved the registry daemon ${tree.registryDaemon} (server ${readJson(path.join(tree.root, 'server', 'package.json')).version}), which every connect refuses as version_mismatch` : '';
  const ev = `server pins supersurf-daemon "${pin}" (exact=${exact}); this tree's daemon is ${daemonVer}${resolved}`;
  return exact && pin === daemonVer ? pass(ev) : fail(ev);
});

reg('12', 'G', 'The installer adds the SuperSurf plugin after registering the MCP server', async ({ tree }) => {
  const r = runInstaller(tree, ['--yes', '--client', 'claude'], { claude: true });
  try {
    const lines = r.calls.split('\n').filter((l) => l.startsWith('claude '));
    const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const mcp = idx(/^claude mcp add .*supersurf/), mk = idx(/^claude plugin marketplace add LiquidBuiltIt\/Supersurf/), inst = idx(/^claude plugin install supersurf@supersurf/);
    const ev = `exit ${r.status}; claude calls: ${lines.filter((l) => !/--help/.test(l)).map((l) => l.replace(/^claude /, '')).join(' ; ') || 'none'}`;
    return r.status === 0 && mcp >= 0 && mk > mcp && inst > mk ? pass(ev) : fail(`${ev} :: ${J(r.out.split('\n').filter(Boolean).slice(-2).join(' | ')).slice(0, 120)}`);
  } finally { r.done(); }
});

reg('15', 'G', 'Dev mode: `SUPERSURF_DEV_ENVIRONMENT` routes server, daemon and extension to the clone', async ({ tree }) => {
  const mod = path.join(tree.root, 'shared', 'dist', 'dev-source.js');
  if (!fs.existsSync(mod)) return fail(`${path.relative(tree.root, mod)} does not exist in this tree`);
  const probe = (envRoot: string | null) => spawnSync(process.execPath, ['-e',
    `const {devSource}=require(${JSON.stringify(mod)});console.log(JSON.stringify(['server','daemon','extension'].map(devSource)))`], {
    env: { PATH: process.env.PATH || '', ...(envRoot ? { SUPERSURF_DEV_ENVIRONMENT: envRoot } : {}) }, encoding: 'utf8' });
  const good = probe(tree.root);
  const got: (string | null)[] = (() => { try { return JSON.parse(good.stdout.trim()); } catch { return []; } })();
  const want = [`server/dist/cli.js`, `daemon/dist/main.js`, `extension`].map((x) => path.join(tree.root, x));
  const routed = want.every((w, i) => got[i] === w);
  const bad = probe(os.tmpdir());
  const fellBack = /not a SuperSurf repo root/.test(bad.stderr) && bad.stdout.trim() === '[null,null,null]';
  const ev = `routes with var set: ${routed ? 'server, daemon, extension all resolved into the clone' : J(good.stdout || good.stderr).slice(0, 120)}; bad root falls back with stderr message=${fellBack}`;
  return routed && fellBack ? pass(ev) : fail(ev);
});

reg('21', 'G', 'Plugin manifest and marketplace files are present, valid JSON, and point at real skills', async ({ tree }) => {
  const mk = path.join(tree.root, '.claude-plugin', 'marketplace.json');
  const pl = path.join(tree.root, 'plugin', '.claude-plugin', 'plugin.json');
  const missing = [mk, pl].filter((f) => !fs.existsSync(f)).map((f) => path.relative(tree.root, f));
  if (missing.length) return fail(`missing: ${missing.join(', ')}`);
  let m: any, p: any;
  try { m = readJson(mk); p = readJson(pl); } catch (e: any) { return fail(`invalid JSON: ${e.message}`); }
  const skills = ['supersurf', 'navigation', 'doctor', 'creating-playbooks'];
  const lacking = skills.filter((s) => !fs.existsSync(path.join(tree.root, 'plugin', 'skills', s, 'SKILL.md')));
  const entry = (m.plugins ?? []).find((x: any) => x.name === 'supersurf');
  const ev = `marketplace "${m.name}" lists supersurf=${!!entry}; plugin.json name="${p.name}"; skills missing: ${lacking.join(', ') || 'none'}`;
  return entry && p.name === 'supersurf' && lacking.length === 0 ? pass(ev) : fail(ev);
});

reg('29', 'G', 'Published licence metadata matches LICENSE (Apache-2.0 with Commons Clause)', async ({ tree }) => {
  const lic = fs.readFileSync(path.join(tree.root, 'LICENSE'), 'utf8');
  const isCommons = /^The Commons Clause/i.test(lic);
  const decl: Record<string, string> = {};
  for (const d of ['.', 'server', 'daemon', 'cli']) {
    const f = path.join(tree.root, d, 'package.json');
    if (fs.existsSync(f)) decl[d === '.' ? 'root' : d] = readJson(f).license;
  }
  const bad = Object.entries(decl).filter(([, v]) => v !== 'SEE LICENSE IN LICENSE').map(([k, v]) => `${k}="${v}"`);
  const ev = `LICENSE is Commons Clause=${isCommons}; package.json licence: ${Object.entries(decl).map(([k, v]) => `${k}="${v}"`).join(', ')}`;
  return isCommons && bad.length === 0 ? pass(ev) : fail(ev);
});

// ───────────────────────── tier E: version mismatch (release-candidate overlay) ─────────────────────────

/**
 * Both trees still say 4.0.0 (version.bump has not run), so a "5.0.0 daemon" has to be made: copy the tree's
 * server/ and daemon/ to a throwaway dir with package.json versions set to 5.0.0, wire node_modules to the
 * tree's own, and point `supersurf-daemon` at the copy. The tree itself is never modified.
 */
function buildRc(tree: Tree, home: string): { serverEntry: string } {
  const rc = path.join(home, 'rc');
  for (const d of ['server', 'daemon']) {
    fs.cpSync(path.join(tree.root, d), path.join(rc, d), { recursive: true, filter: (s) => !/[\\/](node_modules|src|tests)([\\/]|$)/.test(s) });
    const pj = path.join(rc, d, 'package.json');
    const j = readJson(pj);
    j.version = '5.0.0';
    if (j.dependencies?.['supersurf-daemon']) j.dependencies['supersurf-daemon'] = '5.0.0';
    fs.writeFileSync(pj, JSON.stringify(j, null, 2));
  }
  const link = (srcNm: string, dstNm: string) => {
    if (!fs.existsSync(srcNm)) return;
    fs.mkdirSync(dstNm, { recursive: true });
    for (const e of fs.readdirSync(srcNm)) {
      if (e === 'supersurf-daemon' || e === 'supersurf-daemon.orig-registry' || e === '.bin') continue;
      try { fs.symlinkSync(fs.realpathSync(path.join(srcNm, e)), path.join(dstNm, e)); } catch { /* dangling entry */ }
    }
  };
  link(path.join(tree.root, 'node_modules'), path.join(rc, 'node_modules'));
  link(path.join(tree.root, 'server', 'node_modules'), path.join(rc, 'server', 'node_modules'));
  link(path.join(tree.root, 'daemon', 'node_modules'), path.join(rc, 'daemon', 'node_modules'));
  fs.symlinkSync(path.join(rc, 'daemon'), path.join(rc, 'node_modules', 'supersurf-daemon'));
  return { serverEntry: path.join(rc, 'server', 'dist', 'cli.js') };
}

reg('28', 'E', 'The version-mismatch message names the stale side (an old server under a newer daemon)', async ({ tree }) => {
  const env = new Env(tree);
  try {
    const rc = buildRc(tree, env.home);
    const newer = env.proc('c28rc', 'script', {}, rc.serverEntry); // 5.0.0 server: spawns the 5.0.0 daemon and keeps a live session on it
    const first = await newer.connect('c28rc');
    if (first.isError) return fail(`could not stand up the 5.0.0 daemon: ${J(first.text).slice(0, 200)}`);
    const old = env.proc('c28old', 'script'); // the tree's own 4.0.0 server
    const r = await old.connect('c28old');
    const msg = String(r.json?.message ?? r.text);
    const ev = `4.0.0 server vs live 5.0.0 daemon -> ${J(msg).slice(0, 330)}`;
    if (!r.isError) return fail(`the connect was not refused: ${ev}`);
    const namesServer = /server\W{0,4}\s+is the stale side|MCP client/i.test(msg);
    return namesServer ? pass(ev) : fail(ev);
  } finally { await env.down(); }
}, true);

reg('E2', 'E', 'A 5.0.0 daemon refuses a 4.x extension, and `connect` says so', async ({ tree }) => {
  const baseExt = argv('--baseline-ext') || path.resolve(HERE, '..', '..', 'bench-v4-baseline', 'extension');
  if (!fs.existsSync(path.join(baseExt, 'manifest.json'))) return skip(`baseline extension not found at ${baseExt}`);
  const extVersion = readJson(path.join(baseExt, 'manifest.json')).version;
  const env = new Env(tree, { extensionDir: baseExt });
  try {
    const rc = buildRc(tree, env.home);
    const a = env.proc('e2a', 'script', {}, rc.serverEntry);
    const first = await a.connect('e2a');
    if (first.isError) return fail(`could not stand up the 5.0.0 daemon: ${J(first.text).slice(0, 200)}`);
    env.launchChromium(); // loads the 4.x extension
    const b = env.proc('e2b', 'script', {}, rc.serverEntry);
    let last: Reply | null = null;
    const until = Date.now() + 50_000;
    while (Date.now() < until) {
      await sleep(2500);
      last = await b.connect('e2b');
      if (last.isError) break;
      await b.call('disconnect', {}, 8000).catch(() => {});
    }
    const msg = String(last?.json?.message ?? last?.text ?? '');
    const ev = `5.0.0 daemon + extension ${extVersion} -> ${last?.isError ? J(last.json?.error ?? '') + ': ' : 'connect ACCEPTED: '}${J(msg).slice(0, 260)}`;
    return last?.isError && /extension/i.test(msg) && /version|update|older|mismatch/i.test(msg) ? pass(ev) : fail(ev);
  } finally { await env.down(); }
}, true);

// ==MORE==

// ───────────────────────── runner ─────────────────────────

function argv(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function runAll(): Promise<void> {
  const root = path.resolve(argv('--root') || '');
  if (!argv('--root') || !fs.existsSync(path.join(root, 'server', 'dist', 'cli.js'))) {
    throw new Error('usage: --root <tree with built server/dist> [--label name] [--out file.json] [--only 3,4]');
  }
  const label = argv('--label') || path.basename(root);
  const out = argv('--out') || path.join(process.env.TMPDIR || os.tmpdir(), `bench-${label}.json`);
  const only = argv('--only')?.split(',');
  const tree = describeTree(root);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8')).version;
  process.stderr.write(`bench: ${label} root=${root} isMain=${tree.isMain} v${version}\n`);

  let sharedP: Promise<Shared> | null = null;
  let sharedEnv: Env | null = null;
  const shared = () => (sharedP ||= (async () => {
    const env = new Env(tree, { config: { experiments: { fingerprinting: true, page_diffing: false }, logging: { usage_metrics: true } } });
    sharedEnv = env;
    const pageA = await env.fixture(labelPage('a'));
    const pageB = await env.fixture(labelPage('b'));
    const boot = env.proc('bench-boot', 'script');
    await env.browserUp(boot);
    return { env, pageA, pageB, boot };
  })());

  const results: CheckResult[] = [];
  const ordered = [...CHECKS.filter((c) => !c.solo), ...CHECKS.filter((c) => c.solo)];
  let tornDown = false;
  for (const c of ordered) {
    if (only && !only.includes(c.id)) continue;
    if (c.solo && !tornDown) {
      tornDown = true;
      if (sharedEnv) { await (sharedEnv as Env).down(); sharedEnv = null; sharedP = null; await sleep(1500); }
    }
    const t0 = Date.now();
    let o: Outcome;
    try {
      o = await Promise.race([
        c.run({ tree, shared, label }),
        new Promise<Outcome>((_, rej) => setTimeout(() => rej(new Error('check timed out after 180s')), 180_000)),
      ]);
    } catch (e: any) {
      o = fail(`threw: ${oneLine(String(e?.message || e), 300)}`);
    }
    results.push({ id: c.id, ...o });
    process.stderr.write(`  [${o.verdict}] ${c.id} (${Math.round((Date.now() - t0) / 1000)}s) ${o.evidence}\n`);
  }
  if (sharedEnv) await (sharedEnv as Env).down();
  fs.writeFileSync(out, JSON.stringify({ label, root, isMain: tree.isMain, version, date: new Date().toISOString(), results }, null, 2));
  process.stderr.write(`wrote ${out}\n`);
}

// ───────────────────────── report ─────────────────────────

const EXPECTED_RED = new Set(['1', '2', '10']); // not on main until their PR merges
const ORDER = (id: string) => (/^\d+$/.test(id) ? Number(id) : id === 'HN' ? 1000 : 2000);

function judge(id: string, base: string | undefined, main: string | undefined): { verdict: string; cls: string } {
  if (base === 'SKIP' || main === 'SKIP') return { verdict: 'skip', cls: 'skip' };
  if (main === 'FAIL') return EXPECTED_RED.has(id)
    ? { verdict: 'expected red until PR merges', cls: 'exp' }
    : { verdict: 'regression / bug', cls: 'bad' };
  if (main === 'PASS' && base === 'FAIL') return { verdict: 'proven', cls: 'ok' };
  if (main === 'PASS' && base === 'PASS') return { verdict: 'not proven (check does not test the change)', cls: 'np' };
  return { verdict: 'incomplete', cls: 'np' };
}

function mergeReport(baseFile: string, mainFile: string, out: string, checks: Check[]): void {
  let a = readJson(baseFile), b = readJson(mainFile);
  if (a.isMain && !b.isMain) [a, b] = [b, a]; // accept either order
  const get = (r: any, id: string) => r.results.find((x: any) => x.id === id);
  const meta = new Map(checks.map((c) => [c.id, c]));
  const ids = [...new Set<string>([...a.results, ...b.results].map((r: any) => r.id))].sort((x, y) => ORDER(x) - ORDER(y) || x.localeCompare(y));
  const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const counts: Record<string, number> = { proven: 0, 'not proven': 0, regression: 0, skip: 0, 'expected red': 0, incomplete: 0 };
  const rows = ids.map((id) => {
    const ra = get(a, id), rb = get(b, id), m = meta.get(id);
    const j = judge(id, ra?.verdict, rb?.verdict);
    const k = j.cls === 'ok' ? 'proven' : j.cls === 'np' ? (j.verdict === 'incomplete' ? 'incomplete' : 'not proven') : j.cls === 'bad' ? 'regression' : j.cls === 'exp' ? 'expected red' : 'skip';
    counts[k]++;
    const cell = (r: any) => (r ? `<span class="v ${r.verdict}">${r.verdict}</span>` : '<span class="v SKIP">-</span>');
    return `<tr class="${j.cls}"><td>${esc(id)}</td><td>${esc(m?.entry ?? '')}</td><td>${esc(m?.tier ?? '')}</td><td>${cell(ra)}</td><td>${cell(rb)}</td>` +
      `<td class="ev"><div><b>baseline</b> ${esc(ra?.evidence ?? '-')}</div><div><b>main</b> ${esc(rb?.evidence ?? '-')}</div></td><td class="vd">${esc(j.verdict)}</td></tr>`;
  });
  const html = `<!doctype html><meta charset="utf-8"><title>SuperSurf 5.0.0 release acceptance bench</title>
<style>
body{background:#0d1117;color:#c9d1d9;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;margin:24px}
h1{font-size:18px;margin:0 0 4px}.sub{color:#8b949e;margin-bottom:16px}
.sum span{display:inline-block;margin:0 14px 10px 0;padding:3px 9px;border:1px solid #30363d;border-radius:4px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #30363d;padding:5px 8px;vertical-align:top;text-align:left}
th{background:#161b22;position:sticky;top:0}.ev{max-width:620px;word-break:break-word;color:#9da7b3}.ev b{color:#6e7681;margin-right:6px}
.v{padding:1px 6px;border-radius:3px;font-weight:bold}.PASS{background:#12351f;color:#3fb950}.FAIL{background:#3d1418;color:#f85149}.SKIP{background:#2b2b2b;color:#8b949e}
tr.ok .vd{color:#3fb950}tr.np .vd{color:#d29922}tr.bad .vd{color:#f85149;font-weight:bold}tr.exp .vd{color:#a371f7}tr.skip .vd{color:#8b949e}
tr.bad{background:#2a1215}.vd{white-space:nowrap}
</style>
<h1>SuperSurf 5.0.0 release acceptance bench</h1>
<div class="sub">baseline ${esc(a.label)} (v${esc(a.version)}, ${esc(a.date)}) vs main ${esc(b.label)} (v${esc(b.version)}, ${esc(b.date)}). Real headless Chromium, throwaway HOME. Package versions on main are still ${esc(b.version)}; checks 28 and E2 run on a 5.0.0 overlay copy.</div>
<div class="sum">${Object.entries(counts).map(([k, v]) => `<span>${k}: <b>${v}</b></span>`).join('')}</div>
<table><thead><tr><th>#</th><th>entry</th><th>tier</th><th>baseline</th><th>main</th><th>evidence</th><th>verdict</th></tr></thead><tbody>
${rows.join('\n')}
</tbody></table>`;
  fs.writeFileSync(out, html);
  process.stderr.write(`report ${out}: ${JSON.stringify(counts)}\n`);
}

(async () => {
  if (process.argv.includes('--merge')) {
    mergeReport(argv('--merge')!, process.argv[process.argv.indexOf('--merge') + 2], argv('--report')!, CHECKS);
  } else {
    await runAll();
  }
  process.exit(0);
})().catch((e) => { process.stderr.write(`bench-release: ${e?.stack || e}\n`); process.exit(1); });
