/**
 * E9 resume, end to end (D9 row 4): BUILT daemons, the real Go shim as the MCP client and a real
 * headless Chromium with the built extension (port-patched copy), each case in its own throwaway HOME
 * on its own free port. The hand-off is the real `restart` CLI, except `rollback`, which sends
 * `daemon_restart` itself because `ensure` (run by the CLI) deletes the bad `entry` it needs.
 * Seams (dev env only): SUPERSURF_TEST_RESUME=off, SUPERSURF_TEST_HANDOFF_FAULT, SUPERSURF_TEST_RESUME_GRACE_MS.
 * Skipped with a message when Chromium, `go` or `daemon/dist` is missing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { ResumeRig, McpShim, chromiumBinary, alive, request, sleep, waitFor, MAIN } from './helpers/resume-rig';
import { PKG_VERSION } from './helpers/real-daemon';

const REPO = path.resolve(__dirname, '..', '..');
const GO = [process.env.GO, '/home/claudebox/.local/go/bin/go', 'go']
  .filter((g): g is string => !!g)
  .find((g) => spawnSync(g, ['version'], { stdio: 'ignore' }).status === 0);
const CHROME = chromiumBinary();
const missing = !GO ? 'no go toolchain found' : !CHROME ? 'no Chromium found' : !fs.existsSync(MAIN) ? 'daemon/dist is not built (npm run build)'
  : !fs.existsSync(path.join(REPO, 'extension', 'dist', 'background.js')) ? 'extension/dist is not built' : '';
if (missing) console.warn(`resume-e2e skipped: ${missing}`);

const MARK = /m-[0-9a-f]{12}/;
vi.setConfig({ maxConcurrency: 3 }); // each case starts a Chromium; more at once starves them on a busy host
const T = 100_000; // per-test bound; the file runs its cases concurrently

let tmp = '';
let shimBin = '';
let fixture: http.Server;
let fixturePort = 0;
const hits = new Map<string, number>();
const rigs: ResumeRig[] = [];

beforeAll(async () => {
  if (missing) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r9-'));
  shimBin = path.join(tmp, 'supersurf-shim');
  const b = spawnSync(GO!, ['build', '-o', shimBin, '.'], { cwd: path.join(REPO, 'shim'), encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`go build failed: ${b.stderr}`);
  // Every load of a page gets a new random marker, so an equal marker read later proves the same page, not a reload.
  fixture = http.createServer((req, res) => {
    const p = req.url ?? '/';
    hits.set(p, (hits.get(p) ?? 0) + 1);
    res.setHeader('content-type', 'text/html');
    res.end(`<html><head><title>resume</title></head><body>${p}<script>document.body.dataset.marker='m-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}'</script></body></html>`);
  });
  await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
  fixturePort = (fixture.address() as net.AddressInfo).port;
}, 120_000);

afterAll(() => {
  for (const r of rigs) r.cleanup();
  fixture?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

interface Ctx { rig: ResumeRig; shim: McpShim; oldpid: number; browser: number | null; marker: string; hits: number; tabId: number | null }

async function newRig(): Promise<ResumeRig> {
  const rig = await ResumeRig.create(shimBin, CHROME!, fixturePort);
  rigs.push(rig);
  return rig;
}

async function readMarker(shim: McpShim, ms = 45_000): Promise<{ m: string | null; error?: string; text: string }> {
  const r = await shim.tool('browser_evaluate', { expression: 'document.body.dataset.marker', purpose: 'read the fixture page marker' }, ms);
  return { m: r.text.match(MARK)?.[0] ?? null, error: r.error, text: r.text };
}

/** One managed profile `p1`, one tab on the fixture page, its marker read back. Or an unmanaged browser when `profile` is null. */
async function bootOnce(rig: ResumeRig, env: Record<string, string>, profile: string | null): Promise<Ctx> {
  const oldpid = await rig.start([], env);
  const shim = rig.mcp();
  await shim.initialize();
  if (profile) {
    const c = await shim.tool('profile_create', { name: profile });
    expect(c.error, c.text).toBeUndefined();
    const k = await shim.tool('connect', { client_id: 'agent-a', profile }, 60_000);
    expect(k.error, `${k.text}\n${rig.daemonLog().slice(-1500)}`).toBeUndefined();
  } else {
    const udd = path.join(rig.home, 'unmanaged-ud');
    const c = spawn(rig.chrome, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${udd}`, `--load-extension=${path.join(rig.root, 'extension')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    c.unref();
    await waitFor(async () => (await rig.status()).extensionConnected === true, 30_000, 'the unmanaged extension to connect');
    const k = await shim.tool('connect', { client_id: 'agent-a' }, 60_000);
    expect(k.error, k.text).toBeUndefined();
  }
  const t = await shim.tool('browser_tabs', { action: 'new', url: rig.pageUrl('/page') }, 60_000);
  expect(t.error, t.text).toBeUndefined();
  const m = await readMarker(shim);
  expect(m.m, m.text).toBeTruthy();
  const st = await rig.status();
  const s = st.sessions.find((x: any) => x.sessionId === 'agent-a');
  return { rig, shim, oldpid, browser: profile ? rig.browserPid(profile) : null, marker: m.m!, hits: hits.get(rig.pagePath('/page')) ?? 0, tabId: s?.attachedTabId ?? null };
}

/**
 * Boot with one retry on a fresh rig. Known product flake, outside E9: the registration page posts
 * `register-profile` once, so when the headless extension starts late (busy host) the content script
 * misses it, the extension connects as `unmanaged` and `connect` gives "No extension connection".
 */
async function boot(env: Record<string, string> = {}, profile: string | null = 'p1'): Promise<Ctx> {
  const first = await newRig();
  try {
    return await bootOnce(first, env, profile);
  } catch (e) {
    if (!/No extension connection|no reply to tools\/call/.test(String((e as Error).message))) throw e;
    first.cleanup();
    return bootOnce(await newRig(), env, profile);
  }
}

/** The hand-off through the real CLI. */
async function handoff(c: Ctx): Promise<number> {
  const r = await c.rig.restart(60_000);
  expect(r.out, 'restart output').toMatch(/restarted/i);
  expect(r.code).toBe(0);
  const pid = (await c.rig.status()).pid;
  expect(pid).not.toBe(c.oldpid);
  return pid;
}

/** The survive assertions: what must hold after a hand-off with resume on, and must NOT hold with it off. Empty = survived. */
async function survival(c: Ctx, readMs = 45_000): Promise<string[]> {
  const bad: string[] = [];
  if (!c.browser || !alive(c.browser) || c.rig.browserPid('p1') !== c.browser) bad.push('the Chromium process changed or died');
  const r = await readMarker(c.shim, readMs).catch((e) => ({ m: null, error: String(e), text: '' }));
  if (r.m !== c.marker) bad.push(`page marker read back ${r.m ?? `nothing (${r.error ?? r.text.slice(0, 80)})`}, wanted ${c.marker}`);
  if ((hits.get(c.rig.pagePath('/page')) ?? 0) !== c.hits) bad.push('the fixture page was loaded again');
  return bad;
}

const log = (c: Ctx) => c.rig.daemonLog();
const bareTool = (c: Ctx) => c.shim.tool('browser_tabs', { action: 'list' }, 30_000);

describe.skipIf(!!missing)('E9 resume end to end (real daemons, Go shim, headless Chromium)', () => {
  describe.concurrent('hand-off with resume', () => {
    it('survive: same Chromium, same page, no connect after the hand-off', async () => {
      const c = await boot();
      const succ = await handoff(c);
      expect(await survival(c)).toEqual([]);
      expect(log(c)).toMatch(/Resume: adopted 1 browser\(s\), restored 1 session\(s\), dropped 0/);
      expect((await c.rig.status()).pid).toBe(succ);
      expect(fs.existsSync(c.rig.snapshot)).toBe(false); // used once
    }, T);

    it('control: with the resume seam off the survive assertions fail', async () => {
      const c = await boot({ SUPERSURF_TEST_RESUME: 'off' });
      await handoff(c);
      await waitFor(() => !alive(c.browser), 20_000, 'the old daemon to kill the browser (resume off)');
      const bad = await survival(c, 15_000);
      expect(bad.length, `survive assertions that failed with resume off: ${JSON.stringify(bad)}`).toBeGreaterThanOrEqual(2);
      expect(bad.join('|')).toMatch(/Chromium process changed or died/);
      expect(bad.join('|')).toMatch(/page marker/);
    }, T);

    it('extension reconnect: the extension rejoins the successor, no new browser is spawned', async () => {
      const c = await boot();
      await handoff(c);
      await waitFor(async () => (await c.rig.status()).extensionConnected === true, 40_000, 'the extension to reconnect to the successor');
      expect(c.rig.browserPid('p1')).toBe(c.browser);
      expect(log(c)).not.toMatch(/Spawned Chromium|Spawning Chromium/i);
      const r = await readMarker(c.shim);
      expect(r.m).toBe(c.marker);
    }, T);

    it('registry restore: session, tabs, profile and running pid come back', async () => {
      const c = await boot();
      await handoff(c);
      const st = await c.rig.status();
      const s = st.sessions.find((x: any) => x.sessionId === 'agent-a');
      expect(s, JSON.stringify(st.sessions)).toBeTruthy();
      expect(s.profileId).toBe('p1');
      expect(s.attachedTabId).toBe(c.tabId);
      expect(s.ownedTabCount).toBeGreaterThanOrEqual(1);
      const pl = await c.shim.tool('profile_list', {}, 45_000);
      expect(pl.text).toMatch(/p1/);
      expect(pl.text).toMatch(new RegExp(`${c.browser}|running`, 'i'));
    }, T);

    it('legacy session ends: its created tab closes, the shim session keeps its own', async () => {
      const c = await boot();
      const rig = c.rig;
      const legacy = await legacyClient(rig, 'legacy-a');
      await legacy.rpc('profiles.connect', { profile: 'p1' }, 60_000);
      await legacy.rpc('createTab', { url: rig.pageUrl('/legacy') }, 75_000);
      const before = await rig.pageTargets(rig.udd('p1'));
      expect(before.some((t) => t.url.includes('/legacy?'))).toBe(true);
      await handoff(c);
      await waitFor(async () => !(await rig.pageTargets(rig.udd('p1'))).some((t) => t.url.includes('/legacy?')), 40_000, 'the legacy session tab to close');
      const after = await rig.pageTargets(rig.udd('p1'));
      expect(after.some((t) => t.url.includes('/page?'))).toBe(true);
      expect(await survival(c)).toEqual([]);
      expect((await rig.status()).sessions.some((x: any) => x.sessionId === 'legacy-a')).toBe(false);
      legacy.close();
    }, T);

    it('unmanaged session: resumes against the unmanaged slot', async () => {
      const c = await boot({}, null);
      await handoff(c);
      const r = await readMarker(c.shim);
      expect(r.m, r.text).toBe(c.marker);
      expect((await c.rig.status()).extensionConnected).toBe(true);
      expect((await c.rig.status()).sessions.find((x: any) => x.sessionId === 'agent-a')?.profileId ?? null).toBeNull();
      expect(c.hits).toBe(1);
      expect(hits.get(c.rig.pagePath('/page'))).toBe(1);
    }, T);

    it('call in flight at the commit fails once at the shim, is not re-sent, and the next call works', async () => {
      const c = await boot();
      const slow = await c.shim.send('tools/call', { name: 'browser_interact', arguments: { actions: [{ type: 'wait', timeout: 8000 }] } }, 60_000);
      await sleep(300);
      await handoff(c);
      const r = await slow.reply;
      expect(r.error?.code ?? (r.result?.isError ? 'tool error' : 'ok'), JSON.stringify(r).slice(0, 300)).not.toBe('ok');
      if (r.error) expect(r.error.message).toMatch(/daemon connection lost|not retried|restarting/i);
      await sleep(10_000); // a re-send would answer the same id again
      expect(c.shim.lines.filter((l) => l.id === slow.id).length).toBe(1);
      expect(await survival(c)).toEqual([]);
    }, T);
  });

  describe.concurrent('bad hand-offs', () => {
    it('browser death mid hand-off: the session is dropped, a fresh connect spawns a new browser', async () => {
      const c = await boot({ SUPERSURF_TEST_HANDOFF_FAULT: 'resume-kill-browser' });
      await handoff(c);
      await waitFor(() => !alive(c.browser), 20_000, 'the browser to be killed');
      await waitFor(() => /dropped 1/.test(log(c)), 20_000, 'the drop line');
      expect((await bareTool(c)).error ?? (await bareTool(c)).text).toBeTruthy();
      expect((await c.rig.status()).sessions.some((x: any) => x.sessionId === 'agent-a')).toBe(false);
      const k = await c.shim.tool('connect', { client_id: 'agent-a', profile: 'p1' }, 60_000);
      expect(k.error, k.text).toBeUndefined();
      expect(c.rig.browserPid('p1')).toBeTruthy();
      expect(c.rig.browserPid('p1')).not.toBe(c.browser);
    }, T);

    it.each(['resume-corrupt', 'resume-stale'])('%s snapshot: no resume, the logged browser is reaped, a fresh connect works', async (fault) => {
      const c = await boot({ SUPERSURF_TEST_HANDOFF_FAULT: fault });
      await handoff(c);
      await waitFor(() => !alive(c.browser), 20_000, 'the logged browser to be reaped');
      expect(log(c)).toMatch(new RegExp(`Resume snapshot unusable \\(${fault === 'resume-corrupt' ? 'corrupt|bad_shape' : 'stale'}\\)`));
      expect(fs.existsSync(c.rig.snapshot)).toBe(false);
      const r = await readMarker(c.shim, 20_000);
      expect(r.m).toBeNull();
      const k = await c.shim.tool('connect', { client_id: 'agent-a', profile: 'p1' }, 60_000);
      expect(k.error, k.text).toBeUndefined();
      expect(c.rig.browserPid('p1')).not.toBe(c.browser);
    }, T);

    it('successor crash after the commit: a cold start reaps the orphan browser and deletes the snapshot', async () => {
      const c = await boot({ SUPERSURF_TEST_HANDOFF_FAULT: 'crash-after-commit' });
      await c.rig.restart(30_000); // reply may be the committed line or a failure; what counts is the state below
      await waitFor(() => !alive(c.oldpid), 20_000, 'the old daemon to exit');
      const succ = Number(fs.readFileSync(c.rig.pidFile, 'utf8'));
      await waitFor(() => !alive(succ), 20_000, 'the successor to die');
      expect(alive(c.browser), 'the browser is an orphan, still running').toBe(true);
      expect(fs.existsSync(c.rig.snapshot), 'the snapshot is left behind').toBe(true);
      const cold = await c.rig.start([], {}); // no seam
      expect(cold).not.toBe(succ);
      await waitFor(() => !alive(c.browser), 20_000, 'the cold start to reap the orphan');
      expect(fs.existsSync(c.rig.snapshot)).toBe(false);
      expect((await c.rig.status()).sessions.some((x: any) => x.sessionId === 'agent-a')).toBe(false);
    }, T);

    it('rollback before the commit: the old daemon keeps serving, the session never moves, no snapshot', async () => {
      const c = await boot();
      const rig = c.rig;
      const bad = path.join(rig.home, 'bad-successor.js');
      fs.writeFileSync(bad, 'process.exit(1);\n');
      fs.writeFileSync(path.join(rig.daemonDir, 'entry'), JSON.stringify({ node: process.execPath, main: bad, version: PKG_VERSION }));
      const reply = await request(rig.sock, { type: 'daemon_restart' }, 40_000);
      expect(reply.type).toBe('handoff_failed');
      expect((await rig.status()).pid).toBe(c.oldpid);
      expect(alive(c.oldpid)).toBe(true);
      expect(fs.existsSync(rig.snapshot)).toBe(false);
      const bad2 = await survival(c);
      expect(bad2, `${bad2.join('|')}\n${log(c).slice(-3000)}`).toEqual([]); // same socket, same session, no connect
      expect(c.shim.lines.some((l) => l.error)).toBe(false);
    }, T);

    it('grace expiry: parked sessions are torn down and the browser is killed', async () => {
      const c = await boot({ SUPERSURF_TEST_RESUME_GRACE_MS: '4000' });
      c.shim.stop(); // SIGSTOP: the socket stays open, but nobody re-registers
      await handoff(c);
      expect((await c.rig.status()).sessions.some((x: any) => x.sessionId === 'agent-a')).toBe(true); // parked
      await waitFor(() => !alive(c.browser), 30_000, 'the browser to be killed at the grace end');
      await waitFor(async () => !(await c.rig.status()).sessions.some((x: any) => x.sessionId === 'agent-a'), 10_000, 'the parked session to be torn down');
    }, T);
  });
});

/** A legacy `session_register` client with JSON-RPC (what an old MCP server process is). */
async function legacyClient(rig: ResumeRig, id: string): Promise<{ rpc(method: string, params?: object, ms?: number): Promise<any>; close(): void }> {
  const s = net.createConnection(rig.sock);
  await new Promise<void>((r, j) => { s.once('connect', () => r()); s.once('error', j); });
  s.on('error', () => {});
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let buf = '';
  let acked = false;
  let n = 0;
  await new Promise<void>((resolve, reject) => {
    s.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (!acked) { if (m.type !== 'session_ack') return reject(new Error(`not acked: ${JSON.stringify(m)}`)); acked = true; resolve(); continue; }
        const p = pending.get(m.id); if (!p) continue;
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    });
    s.write(JSON.stringify({ type: 'session_register', sessionId: id }) + '\n');
  });
  return {
    rpc(method, params = {}, ms = 30_000) {
      const id = ++n;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, ms);
        pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
        s.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    close() { s.destroy(); },
  };
}
