/**
 * Smoke test — parallel-session isolation, end to end in a real browser.
 *
 * WHY THIS IS A BROWSER TEST. A mocked `chrome.*` has exactly one agent, which
 * makes isolation trivially true — and that free assumption IS the defect
 * (`.claude/rules/testing.md`). `extension/tests/session-context.test.ts`
 * claimed to cover "SessionContext isolation" and D1 shipped green under it.
 * Two agents sharing one profile is a property of the real runtime, so it is
 * asserted in the real runtime.
 *
 * WHY TWO PROCESSES. Two `cli.js --script-mode` processes are genuinely
 * independent, so they prove cross-process isolation (assertions 1-4).
 *
 * WHY ONE PROCESS TOO. Subagents of one MCP client share one server process;
 * since username-keyed sessions they are still separate SuperSurf sessions.
 * Assertions 5-9 drive several usernames through ONE process and prove that
 * duplicates are refused, missing/unknown names get the fix-it text, network
 * logs stay separate, and disconnect closes created tabs and releases attached
 * ones.
 *
 * Run after `npm run build`:  npm run smoke.parallel
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require_ = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(REPO_ROOT, 'extension');

/** Hard ceiling on the whole run, so a wedged browser cannot hang `npm test`. */
const DEADLINE_MS = 120_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Teardown, registered by main() once its resources exist so `fail()` cleans up
 * on the failure path too. Without this the test leaks its own daemon on every
 * red run — and that daemon holds port 5555, so the NEXT run dies with
 * EADDRINUSE and reports a connect failure in place of its actual verdict.
 */
let teardown: () => void = () => {};

function fail(message: string): never {
  try { teardown(); } catch { /* best effort — never mask the real failure */ }
  process.stderr.write(`\n✗ FAIL — ${message}\n`);
  process.exit(1);
}

/**
 * SIGTERM the daemon this run's sessions spawned. It lives in the throwaway
 * HOME, so it is this test's to kill — but port 5555 is global, which is why
 * leaving it behind breaks the next run rather than just wasting a process.
 */
function stopDaemon(home: string): void {
  try {
    const pid = Number(fs.readFileSync(path.join(home, '.supersurf', 'daemon.pid'), 'utf8').trim());
    if (pid > 0) process.kill(pid, 'SIGTERM');
    // Wait for it to exit: it logs while shutting down, and a log line that
    // lands mid-rmSync re-creates daemon.log and fails the HOME removal.
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      process.kill(pid, 0); // throws once the daemon is gone
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  } catch { /* never started, or already gone */ }
}
function ok(message: string): void {
  process.stdout.write(`  ✓ ${message}\n`);
}

/**
 * One fixture page per session, served on its own ephemeral port. The port is
 * the isolation marker: a request for :PORT_B in session A's network log is
 * session B's traffic, full stop.
 */
function servePage(label: string): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (req.url === `/${label}-marker.js`) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`window.__marker = '${label}';`);
      return;
    }
    if (req.url === `/${label}-late.js`) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`window.__late = '${label}';`);
      return;
    }
    // `?late=1` adds a SECOND subresource. Assertion 3 needs a request that
    // happens after the other session's screenshot, and it has to originate in
    // the page: `secure_eval` is on by default and blocks
    // document.createElement('script') (`secure-eval.ts:127-137`), so
    // injecting one through browser_evaluate would fail for the wrong reason.
    const late = (req.url || '').includes('late=1');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      `<!doctype html><html><head><title>PAGE-${label.toUpperCase()}</title>` +
      `<script src="/${label}-marker.js"></script>` +
      (late ? `<script src="/${label}-late.js"></script>` : '') +
      `</head><body><h1>PAGE-${label.toUpperCase()}</h1></body></html>`
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

/** A throwaway HOME so the test gets its own ~/.supersurf (sock, pid, profiles). */
function makeSandboxHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-parallel-'));
  fs.mkdirSync(path.join(home, '.supersurf'), { recursive: true });
  return home;
}

/** Launch headless Chromium with the built extension, against a throwaway profile. */
function launchChromium(userDataDir: string): ChildProcess {
  const { findChromiumBinary } = require_(
    path.join(REPO_ROOT, 'daemon', 'dist', 'profiles', 'chrome.js')
  ) as { findChromiumBinary: () => string | null };

  const binary = findChromiumBinary();
  if (!binary) fail('No Chromium binary found. This test needs a real browser.');

  return spawn(
    binary,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      'about:blank',
    ],
    // Own process group: killing the launcher pid alone orphans the zygote,
    // gpu and renderer children, which is how earlier runs left whole
    // Chromium trees behind. `process.kill(-pid)` takes the group.
    { stdio: 'ignore', detached: true }
  );
}

/**
 * The extension retries its WebSocket on a 5s backoff, so "is it attached yet?"
 * is a poll, not a sleep. Ask for the tab list until the daemon answers.
 */
async function waitForExtension(s: Session, timeoutMs = 45_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    const r = await s.send('browser_tabs', { action: 'list' });
    if (r?.success !== false) return;
    last = r.message ?? r.error ?? '';
    await sleep(1000);
  }
  fail(`extension never reached the daemon within ${timeoutMs}ms (last: ${last})`);
}

interface Session {
  name: string;
  child: ChildProcess;
  send: (method: string, params?: any) => Promise<any>;
}

/** Start one `cli.js --script-mode` process and give it a request/response channel. */
function startSession(name: string, home: string): Session {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'dist', 'cli.js'), '--script-mode'], {
    env: { ...process.env, HOME: home, SUPERSURF_EXPERIMENTS: "" },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  let nextId = 1;
  const pending = new Map<number, (r: any) => void>();
  let buffer = '';

  child.stdout!.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const resolve = pending.get(msg.id);
        if (resolve) { pending.delete(msg.id); resolve(msg); }
      } catch { /* non-JSON log line — ignore */ }
    }
  });

  const send = (method: string, params: any = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        if (msg.error) reject(new Error(`[${name}] ${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      // Every call carries this session's username; pass `username: undefined` to send none.
      const withName = 'username' in params ? params : { username: name, ...params };
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: withName }) + '\n');
    });

  return { name, child, send };
}

/** SMOKE_PARALLEL_PROBE=1 dumps raw responses instead of asserting, so the
 *  assertions below are written against shapes observed in this runtime. */
const PROBE = process.env.SMOKE_PARALLEL_PROBE === '1';

function probe(label: string, value: any): void {
  if (PROBE) process.stdout.write(`\n[probe] ${label}\n${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const deadline = setTimeout(() => fail(`deadline exceeded (${DEADLINE_MS}ms)`), DEADLINE_MS);

  const home = makeSandboxHome();
  // Assertion 4 needs usage metrics on, `fingerprinting` on (it clears the
  // `playbooks run` gate) and `page_diffing` OFF so a run can turn it on.
  fs.writeFileSync(
    path.join(home, '.supersurf', 'config.json'),
    JSON.stringify({
      experiments: { fingerprinting: true, page_diffing: false },
      logging: { usage_metrics: true },
    })
  );
  const userDataDir = path.join(home, 'chrome-data');
  const pageA = await servePage('a');
  const pageB = await servePage('b');
  const pageC = await servePage('c');
  // Slow on purpose: session A must make a call while the run's session is alive.
  const playbooksDir = path.join(home, '.supersurf', 'playbooks');
  fs.mkdirSync(playbooksDir, { recursive: true });
  fs.writeFileSync(
    path.join(playbooksDir, 'smoke_flags.playbook.js'),
    `export const meta = { description: 'smoke: hold an experiments-enabled session open', experiments: true };\n` +
    `export default async function ({ supersurf }) {\n` +
    `  await supersurf.goto('http://127.0.0.1:${pageB.port}/');\n` +
    `  await supersurf.wait(6000);\n` +
    `  return 'done';\n}\n`
  );

  let chromium: ChildProcess | null = null;
  const sessions: Session[] = [];
  teardown = () => {
    clearTimeout(deadline);
    for (const s of sessions) s.child.kill();
    if (chromium?.pid) {
      try { process.kill(-chromium.pid, 'SIGKILL'); } catch { chromium.kill('SIGKILL'); }
    }
    stopDaemon(home);
    pageA.close(); pageB.close(); pageC.close();
    fs.rmSync(home, { recursive: true, force: true });
  };

  // Sessions connect BEFORE Chromium launches: `connect` is what spawns the
  // daemon, and the extension retries on a 5s backoff. Start the browser first
  // and its opening WebSocket attempt hits a port nobody is listening on.
  const A = startSession('sm-a', home); sessions.push(A);
  const B = startSession('sm-b', home); sessions.push(B);

  // Distinct usernames: the daemon session id IS the username.
  const connA = await A.send('connect', { username: 'sm-a' });
  const connB = await B.send('connect', { username: 'sm-b' });
  probe('A connect', connA); probe('B connect', connB);
  if (connA?.success === false) fail(`A connect failed: ${connA.message ?? connA.error}`);
  if (connB?.success === false) fail(`B connect failed: ${connB.message ?? connB.error}`);

  chromium = launchChromium(userDataDir);
  await waitForExtension(A);

  // Each session creates and owns exactly one tab, interleaved so neither
  // setup runs to completion before the other starts.
  const tabA = await A.send('browser_tabs', { action: 'new', url: `http://127.0.0.1:${pageA.port}/` });
  const tabB = await B.send('browser_tabs', { action: 'new', url: `http://127.0.0.1:${pageB.port}/` });
  probe('A create', tabA); probe('B create', tabB);
  await sleep(2000);

  // ── Assertion 1 (D2): a session's network log contains only its own traffic.
  const netA = await A.send('browser_network_requests', {});
  const netB = await B.send('browser_network_requests', {});
  probe('A network', netA); probe('B network', netB);

  const urlsA: string[] = (netA.requests ?? []).map((r: any) => r.url);
  const urlsB: string[] = (netB.requests ?? []).map((r: any) => r.url);

  if (!urlsA.some((u) => u.includes(`:${pageA.port}`))) fail('A saw none of its own traffic');
  if (urlsA.some((u) => u.includes(`:${pageB.port}`))) {
    fail(`A's network log contains B's traffic: ${urlsA.filter((u) => u.includes(`:${pageB.port}`)).join(', ')}`);
  }
  if (urlsB.some((u) => u.includes(`:${pageA.port}`))) {
    fail(`B's network log contains A's traffic: ${urlsB.filter((u) => u.includes(`:${pageA.port}`)).join(', ')}`);
  }
  ok('each session\'s network log contains only its own hosts');

  // ── Assertion 2 (D1): each session reports its OWN tab as attached.
  // REGRESSION LOCK, not a defect-proving assertion: the daemon's auto
  // context-switch (`scheduler.ts:181-195`) repairs the attached-tab pointer
  // WITHIN a single command, so this can legitimately pass on unfixed code.
  // It stays here to catch a future regression in that repair behavior.
  const listA = await A.send('browser_tabs', { action: 'list' });
  const listB = await B.send('browser_tabs', { action: 'list' });
  probe('A list', listA); probe('B list', listB);

  const attachedA = listA.attachedTabId ?? listA.attachedTab?.id;
  const attachedB = listB.attachedTabId ?? listB.attachedTab?.id;
  if (attachedA === attachedB) fail(`both sessions report the same attached tab (${attachedA})`);
  ok(`attached tabs are distinct (A=${attachedA} B=${attachedB})`);

  // ── Assertion 3 (D3): B's CDP work must not kill A's capture.
  // A screenshot attaches the debugger to B's tab; on unfixed code that
  // DETACHES A's tab, so A's next page load is never captured.
  await B.send('browser_take_screenshot', {});
  // Navigate A's OWN tab to produce the post-screenshot request. Do not inject
  // a script through browser_evaluate: `secure_eval` blocks
  // document.createElement('script') by default, so the test would go red on a
  // refusal rather than on the CDP detach it exists to catch.
  await A.send('browser_navigate', { action: 'url', url: `http://127.0.0.1:${pageA.port}/?late=1` });
  await sleep(1500);
  const netA2 = await A.send('browser_network_requests', {});
  probe('A network after B screenshot', netA2);
  if (!(netA2.requests ?? []).some((r: any) => r.url.includes('a-late.js'))) {
    fail('A lost network capture after B took a screenshot (CDP detach)');
  }
  ok('A keeps its CDP capture while B uses the debugger');

  // ── Assertion 4 (BACKLOG #65): usage-metrics lines carry THEIR session's flags.
  // `meta.experiments: true` turns every experiment on for the run's own
  // session, and the registry is one per process — so while the run is alive,
  // A's own tool calls share a process with a session where page_diffing is on.
  // The two `getStates(...)` call sites once omitted the session id and
  // unioned, so A's line claimed page_diffing: true. (A cross-PROCESS check
  // cannot show this: B has its own registry.)
  const FLAG = 'page_diffing';
  const run = A.send('playbooks', { action: 'run', name: 'smoke_flags' });
  await sleep(3500); // connect + tab + goto done, script now inside wait(6000)
  await A.send('browser_tabs', { action: 'list' });
  const runRes = await run;
  probe('A playbook run', runRes);
  if (runRes?.isError) fail(`playbook run failed: ${JSON.stringify(runRes).slice(0, 400)}`);

  const sessDir = path.join(home, '.supersurf', 'logs', 'sessions');
  const metricLines = (prefix: string): any[] =>
    fs.readdirSync(sessDir)
      .filter((f) => f.startsWith(`metrics-${prefix}`) && f.endsWith('.ndjson'))
      .flatMap((f) => fs.readFileSync(path.join(sessDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

  // Positive control: the run's own session really had the flag on, so a pass
  // below cannot be vacuous.
  if (!metricLines('playbook-').some((l) => l.experiments?.[FLAG] === true)) {
    fail(`run session never logged ${FLAG}=true — meta.experiments was not activated, assertion 4 would be vacuous`);
  }
  for (const who of ['sm-a', 'sm-b']) {
    const lines = metricLines(`${who}-`);
    if (lines.length === 0) fail(`${who} wrote no usage-metrics lines`);
    const leaked = lines.filter((l) => l.experiments?.[FLAG] === true);
    if (leaked.length) {
      fail(`${who}'s metrics lines show ${FLAG}=true (leaked from the playbook run's session): ${leaked.map((l) => l.tool).join(', ')}`);
    }
  }
  ok(`${FLAG} enabled by a run stays out of the calling session's usage-metrics lines`);

  // ── Assertion 5: duplicate names are refused, in-process and across processes.
  const dupA = await A.send('connect', { username: A.name });
  if (dupA?.error !== 'username_in_use') fail(`same-process duplicate not rejected: ${JSON.stringify(dupA)}`);
  const dupB = await B.send('connect', { username: A.name });
  if (!/already in use/.test(JSON.stringify(dupB))) fail(`cross-process duplicate not rejected: ${JSON.stringify(dupB)}`);
  ok('duplicate usernames are refused');

  // ── Assertion 6: missing and unknown names get the fix-it text.
  const none = await A.send('browser_tabs', { action: 'list', username: undefined });
  if (!/username required/.test(JSON.stringify(none))) fail(`missing username not refused: ${JSON.stringify(none)}`);
  const ghost = await A.send('browser_tabs', { action: 'list', username: 'ghost' });
  if (!/No live session for username "ghost"/.test(String(ghost?.message))) fail(`unknown username not refused: ${JSON.stringify(ghost)}`);
  ok('missing and unknown usernames are refused with the fix-it text');

  // ── Assertion 7: two usernames in ONE process do not share a network log.
  await A.send('connect', { username: 'sm-c' });
  await A.send('browser_tabs', { action: 'new', url: `http://127.0.0.1:${pageC.port}/`, username: 'sm-c' });
  await sleep(1500);
  const netC = JSON.stringify(await A.send('browser_network_requests', { username: 'sm-c' }));
  const netA3 = JSON.stringify(await A.send('browser_network_requests', {}));
  if (!netC.includes(`:${pageC.port}`)) fail('sm-c did not capture its own page');
  if (netA3.includes(`:${pageC.port}`)) fail('sm-a sees sm-c traffic from the same process');
  ok('same-process sessions keep separate network logs');

  // ── Assertion 8: disconnect closes created tabs and releases attached ones.
  const listC = await A.send('browser_tabs', { action: 'list', username: 'sm-c' });
  probe('C list', listC);
  const blankId = (listC.tabs ?? []).find((t: any) => t.url === 'about:blank')?.id;
  if (blankId === undefined) fail('no about:blank tab to attach');
  await A.send('browser_tabs', { action: 'attach', tabId: blankId, username: 'sm-c' });
  await A.send('disconnect', { username: 'sm-c' });
  await sleep(1500);
  const cdpPort = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const live = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  if (live.some((t: any) => String(t.url).includes(`:${pageC.port}`))) fail('created tab survived disconnect');
  if (!live.some((t: any) => t.url === 'about:blank')) fail('attached tab was closed instead of released');
  await A.send('connect', { username: 'sm-d' });
  const listD = JSON.stringify(await A.send('browser_tabs', { action: 'list', username: 'sm-d' }));
  if (!listD.includes('about:blank')) fail('released tab is still hidden in a dead group');
  ok('disconnect closed the created tab and released the attached one');

  // ── Assertion 9: status without a username names nobody.
  const st = await A.send('status', { username: undefined });
  if (st?.daemon?.running !== true) fail(`status did not report a running daemon: ${JSON.stringify(st)}`);
  if (/sm-a|sm-b|sm-d/.test(JSON.stringify(st))) fail(`status leaked usernames: ${JSON.stringify(st)}`);
  ok('nameless status reports health and names nobody');

  teardown();
  process.stdout.write('\n✓ smoke.parallel — sessions stayed isolated across and within processes\n');
}

main().catch((e) => fail(String(e?.stack || e)));
