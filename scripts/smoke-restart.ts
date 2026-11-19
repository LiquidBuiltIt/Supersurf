/**
 * Smoke test — daemon restart hand-off, end to end with the real Go shim.
 *
 * WHY A REAL-PROCESS TEST. The unit and daemon tests drive the hand-off with
 * fixtures. This one runs the whole chain: the real `supersurf-shim` relaying an
 * MCP client's NDJSON, the BUILT daemon, the real `restart` CLI
 * (`shim ensure --install` + `daemon_restart`), and a successor daemon taking the
 * socket over. It asserts what a client sees: the same tool list after a
 * same-version restart, `list_changed` and a new list after a restart to a
 * different build, and the one-shot G4 text for a client that ignores the notice.
 *
 * No browser and no internet. Throwaway HOME (short path), free port, never 5555.
 * The first daemon is started directly with SUPERSURF_DEV_ENVIRONMENT so no
 * extension pull happens (a shim-spawned daemon has a scrubbed env and would try
 * GitHub); a hand-off successor inherits that env. Then `ensure --install` writes
 * `entry` (the daemon is up, so it spawns nothing).
 *
 * Run after `npm run build`:  npm run smoke.restart
 */

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAEMON_PKG = path.join(REPO_ROOT, 'daemon');
const DEADLINE_MS = 120_000;
const G4_TEXT = 'SuperSurf tools changed; run `/mcp reconnect supersurf` to see them.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let teardown: () => void = () => {};
let failing = false;
function fail(message: string): never {
  failing = true;
  try { teardown(); } catch { /* never mask the real failure */ }
  process.stderr.write(`\n✗ FAIL — ${message}\n`);
  process.exit(1);
}
const ok = (m: string) => process.stdout.write(`  ✓ ${m}\n`);
function check(cond: unknown, message: string): asserts cond { if (!cond) fail(message); }

async function waitFor(what: string, ms: number, fn: () => boolean | Promise<boolean>): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return; await sleep(25); }
  fail(`timeout (${ms} ms) waiting for ${what}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** One NDJSON request/reply on a Unix socket. */
function request(sock: string, msg: object, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    let buf = '';
    const t = setTimeout(() => { s.destroy(); reject(new Error('request timeout')); }, timeoutMs);
    s.on('connect', () => s.write(JSON.stringify(msg) + '\n'));
    s.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i === -1) return;
      clearTimeout(t); s.destroy();
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
    });
    s.on('close', () => { clearTimeout(t); reject(new Error('closed before reply')); });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function findGo(): string | null {
  for (const g of [process.env.GO, '/home/claudebox/.local/go/bin/go', 'go']) {
    if (g && spawnSync(g, ['version'], { stdio: 'ignore' }).status === 0) return g;
  }
  return null;
}

/** An MCP client on the shim's stdio: NDJSON JSON-RPC, every line kept. */
class Client {
  child: ChildProcess;
  lines: any[] = [];
  private buf = '';
  private nextId = 1;
  constructor(shimBin: string, port: number, home: string, cwd: string) {
    // A minimal env keeps the shim away from the owner's SUPERSURF_* settings.
    this.child = spawn(shimBin, ['--port', String(port)], { cwd, env: { HOME: home, PATH: process.env.PATH! }, stdio: ['pipe', 'pipe', 'inherit'] });
    this.child.stdout!.on('data', (d) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        try { this.lines.push(JSON.parse(this.buf.slice(0, i))); } catch { /* not JSON */ }
        this.buf = this.buf.slice(i + 1);
      }
    });
  }
  notify(method: string, params?: object) { this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  async call(method: string, params: object = {}, ms = 15_000): Promise<any> {
    const id = this.nextId++;
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const m = this.lines.find((l) => l.id === id);
      if (m) return m;
      await sleep(20);
    }
    fail(`no reply to ${method} (id ${id}) within ${ms} ms`);
  }
  listChanged(): number { return this.lines.filter((l) => l.method === 'notifications/tools/list_changed').length; }
  /** `initialize` until the daemon-hosted engine (not the shim's local answer) replies. */
  async initialize(): Promise<void> {
    for (let i = 0; i < 150; i++) {
      const r = await this.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-restart', version: '0' } });
      if (r.result?.serverInfo?.name === 'SuperSurf') { this.notify('notifications/initialized'); return; }
      await sleep(100);
    }
    fail('the shim never connected to the daemon engine');
  }
  async tools(): Promise<any[]> {
    const r = await this.call('tools/list');
    check(Array.isArray(r.result?.tools), `tools/list failed: ${JSON.stringify(r).slice(0, 300)}`);
    return r.result.tools;
  }
  async status(): Promise<string> {
    const r = await this.call('tools/call', { name: 'status', arguments: {} });
    check(!r.error && !r.result?.isError, `status call failed: ${JSON.stringify(r).slice(0, 300)}`);
    return JSON.stringify(r.result);
  }
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

async function main(): Promise<void> {
  const deadline = setTimeout(() => fail(`run exceeded ${DEADLINE_MS / 1000} s`), DEADLINE_MS);

  const go = findGo();
  if (!go) { process.stdout.write('smoke.restart skipped: no go toolchain\n'); clearTimeout(deadline); return; }
  const mainJs = path.join(DAEMON_PKG, 'dist', 'main.js');
  check(fs.existsSync(mainJs) && fs.existsSync(path.join(DAEMON_PKG, 'dist', 'handoff.js')), 'daemon/dist is not built (run npm run build)');
  const { cmpVersion } = require_(path.join(DAEMON_PKG, 'dist', 'handoff.js')) as { cmpVersion: (a: string, b: string) => number };

  // Throwaway HOME. Every spawn below gets it; assert it before anything starts.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssrs-'));
  const realHome = os.userInfo().homedir;
  check(home !== realHome && !home.startsWith(path.join(realHome, '.supersurf')), 'throwaway HOME collides with the real HOME');
  check(Buffer.byteLength(path.join(home, '.supersurf', 'daemon.sock.next')) < 100, `HOME path too long for a unix socket: ${home}`);
  const sock = path.join(home, '.supersurf', 'daemon.sock');
  const port = await freePort();
  check(port !== 5555, 'free port came back as 5555');
  fs.mkdirSync(path.join(home, '.supersurf'), { recursive: true });

  const pids = new Set<number>();
  const clients: Client[] = [];
  const own: ChildProcess[] = [];
  teardown = () => {
    for (const c of clients) { try { c.child.stdin!.end(); c.child.kill('SIGKILL'); } catch { /* gone */ } }
    for (const c of own) { if (c.pid) pids.add(c.pid); }
    for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
    const until = Date.now() + 5000;
    // Wait for exit: a daemon logging mid-rmSync re-creates daemon.log and fails the removal.
    while (Date.now() < until && [...pids].some(alive)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    if (failing) {
      try { process.stderr.write(`daemon.log tail:\n${fs.readFileSync(path.join(home, '.supersurf', 'logs', 'daemon.log'), 'utf8').slice(-1500)}\n`); } catch { /* none */ }
    }
    fs.rmSync(home, { recursive: true, force: true });
  };
  const status = async () => { const s = await request(sock, { type: 'daemon_status' }); pids.add(s.pid); return s; };

  // Shim binary.
  const shimBin = path.join(home, 'supersurf-shim');
  const b = spawnSync(go, ['build', '-o', shimBin, '.'], { cwd: path.join(REPO_ROOT, 'shim'), encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } });
  check(b.status === 0, `go build failed: ${b.stderr}`);

  // Fixture install dirs: clean copies of package.json + dist, a symlinked node_modules.
  const V: string = JSON.parse(fs.readFileSync(path.join(DAEMON_PKG, 'package.json'), 'utf8')).version;
  const [maj, min, pat] = V.split('-')[0].split('.').map(Number);
  const vB = `${maj}.${min}.${pat + 1}-fixture`;
  const vC = `${maj}.${min}.${pat + 2}-fixture`;
  check(cmpVersion(vB, V) > 0 && cmpVersion(vC, vB) > 0, `fixture versions ${vB}, ${vC} are not newer than ${V} by cmpVersion`);
  const ORIG = 'return [...connectionTools, ...browserTools, ...profileTools, ...debugTools];';
  const fixture = (name: string, version: string, patch?: (src: string) => string): string => {
    const dir = path.join(home, 'fx', name);
    fs.mkdirSync(dir, { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(DAEMON_PKG, 'package.json'), 'utf8'));
    pkg.version = version;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.cpSync(path.join(DAEMON_PKG, 'dist'), path.join(dir, 'dist'), { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    if (patch) {
      const f = path.join(dir, 'dist', 'engine', 'backend.js');
      const src = fs.readFileSync(f, 'utf8');
      check(src.includes(ORIG), 'engine patch anchor not found in dist/engine/backend.js');
      const out = patch(src);
      fs.writeFileSync(f, out);
      check(fs.readFileSync(f, 'utf8').includes(`smoke-fixture:${name}`), `engine patch ${name} did not apply`);
    }
    return dir;
  };
  // B lists one tool fewer (profile_delete); C lists one fewer (profile_list) and one more (smoke_fixture_extra).
  const dirA = fixture('A', V);
  const dirB = fixture('B', vB, (s) => s.replace(ORIG, `/*smoke-fixture:B*/ return [...connectionTools, ...browserTools, ...profileTools, ...debugTools].filter((t) => t.name !== 'profile_delete');`));
  const dirC = fixture('C', vC, (s) => s.replace(ORIG, `/*smoke-fixture:C*/ return [...connectionTools, ...browserTools, ...profileTools, ...debugTools].filter((t) => t.name !== 'profile_list').concat([{ name: 'smoke_fixture_extra', description: 'fixture', inputSchema: { type: 'object', properties: {} } }]);`));
  const mainOf = (d: string) => path.join(d, 'dist', 'main.js');

  // The first daemon, as a shim would start it (--spawned-by=shim), from fixture A.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, SUPERSURF_DEV_ENVIRONMENT: REPO_ROOT };
  const out = fs.openSync(path.join(home, 'daemon.out'), 'w');
  const d0 = spawn(process.execPath, [mainOf(dirA), '--port', String(port), '--spawned-by=shim'], { env, stdio: ['ignore', out, out] });
  own.push(d0);
  await waitFor('the first daemon', 20_000, async () => { try { return (await status()).pid === d0.pid; } catch { return false; } });

  // `ensure --install`: the daemon is up, so it only installs A as versions/<V> and writes `entry`.
  const ens = spawnSync(shimBin, ['ensure', '--install', dirA, '--port', String(port), '--node', process.execPath], { env: { HOME: home, PATH: process.env.PATH! }, encoding: 'utf8' });
  check(ens.status === 0, `shim ensure --install failed: ${ens.stdout}${ens.stderr}`);
  check(JSON.parse(fs.readFileSync(path.join(home, '.supersurf', 'daemon', 'entry'), 'utf8')).version === V, 'ensure did not write entry');

  /** The real CLI, from `cliDir`'s package root, so `ensure --install` installs that build. */
  const restart = async (cliDir: string): Promise<{ oldPid: number; newPid: number }> => {
    const oldPid = (await status()).pid;
    const r = spawnSync(process.execPath, [mainOf(cliDir), 'restart', '--port', String(port)], {
      env: { PATH: process.env.PATH, HOME: home, SUPERSURF_SHIM_BIN: shimBin }, encoding: 'utf8', timeout: 60_000,
    });
    const text = `${r.stdout}${r.stderr}`;
    check(r.status === 0 && text.includes(`Daemon restarted (pid ${oldPid} -> `), `restart did not commit (exit ${r.status}): ${text.slice(-600)}`);
    const newPid = (await status()).pid;
    check(newPid !== oldPid, 'daemon pid did not change');
    await waitFor('the old daemon to exit', 15_000, () => !alive(oldPid));
    return { oldPid, newPid };
  };
  const newClient = () => { const c = new Client(shimBin, port, home, home); clients.push(c); return c; };
  const waitNotice = (c: Client, before: number) => waitFor('notifications/tools/list_changed', 30_000, () => c.listChanged() > before);

  process.stdout.write('smoke.restart\n');

  // Client 1 reacts to the notice.
  const c1 = newClient();
  await c1.initialize();
  const names = (t: any[]) => t.map((x) => x.name);
  const list0 = await c1.tools();
  check(names(list0).includes('profile_delete') && names(list0).includes('profile_list'), 'baseline list lacks profile tools');
  check(count(await c1.status(), G4_TEXT) === 0, 'G4 text before any restart');

  // (a) same-version restart.
  {
    const n = c1.listChanged();
    const { oldPid, newPid } = await restart(dirA);
    await waitNotice(c1, n);
    check(count(await c1.status(), G4_TEXT) === 0, '(a) G4 text after a same-version restart');
    check(JSON.stringify(await c1.tools()) === JSON.stringify(list0), '(a) tools/list changed after a same-version restart');
    ok(`(a) same-version restart ${oldPid} -> ${newPid}: tools/list identical, no G4 text, shim reconnected`);
  }

  // (b) restart to B: one tool fewer; client 1 follows the notice.
  {
    const n = c1.listChanged();
    const { newPid } = await restart(dirB);
    await waitNotice(c1, n);
    const list = await c1.tools();
    check(!names(list).includes('profile_delete') && names(list).includes('profile_list'), `(b) new list is wrong: ${names(list).join(',')}`);
    check(count(await c1.status(), G4_TEXT) === 0, '(b) G4 text after the client refetched tools/list');
    check((await status()).version === vB, `(b) daemon is not ${vB}`);
    ok(`(b) restart to ${vB} (pid ${newPid}): list_changed, profile_delete gone from tools/list, no G4 text`);
  }
  c1.child.stdin!.end();

  // (c) restart to C with a client that never refetches: the first result carries the G4 text once.
  {
    const c2 = newClient();
    await c2.initialize();
    await c2.tools(); // gives the shim a tools_hash for B's list
    const n = c2.listChanged();
    const { newPid } = await restart(dirC);
    await waitNotice(c2, n); // seen, ignored: no tools/list
    check(count(await c2.status(), G4_TEXT) === 1, '(c) first result after the restart lacks the G4 text exactly once');
    check(count(await c2.status(), G4_TEXT) === 0, '(c) second result repeats the G4 text');
    const list = await c2.tools();
    check(names(list).includes('smoke_fixture_extra') && !names(list).includes('profile_list'), `(c) new list is wrong: ${names(list).join(',')}`);
    ok(`(c) restart to ${vC} (pid ${newPid}): ignoring client got the G4 text once, none on the second call`);
  }

  // (d) a frozen 4.1.0 legacy client: session_register as client.ts sent it at 4.1.0.
  {
    const reply = await new Promise<any>((resolve, reject) => {
      const s = net.createConnection(sock);
      let buf = '';
      const t = setTimeout(() => { s.destroy(); reject(new Error('no handshake reply')); }, 5000);
      s.on('connect', () => s.write(JSON.stringify({ type: 'session_register', sessionId: 'smoke-legacy-4.1.0' }) + '\n'));
      s.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i !== -1) { clearTimeout(t); s.destroy(); resolve(JSON.parse(buf.slice(0, i))); } });
      s.on('error', reject);
    }).catch((e) => fail(`(d) ${e.message}`));
    check(reply.type === 'session_ack', `(d) legacy handshake got ${JSON.stringify(reply).slice(0, 200)}`);
    ok('(d) frozen 4.1.0 legacy client: session_register acked, not rejected');
  }

  clearTimeout(deadline);
  teardown();
  process.stdout.write('✓ smoke.restart passed\n');
}

main().catch((e) => fail(String(e?.stack ?? e)));
