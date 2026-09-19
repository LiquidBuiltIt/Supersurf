/**
 * Smoke test — element-miss hint identity, end to end in a real browser.
 *
 * WHY THIS IS A BROWSER TEST AND NOT A VITEST UNIT TEST — read before replacing
 * it with something faster.
 *
 * The server suite was green, including brand-new ephemeral-handle tests, when
 * the news.ycombinator.com defect shipped. Every one of those tests missed it
 * for one reason: none of them closed the loop
 *
 *     candidate element -> described selector -> re-query -> same element?
 *
 * The executed-page-code harness in `tests/` proves ESCAPING (it runs the real
 * emitted source against a fake element), but its fake element never sits in a
 * queryable document, so it cannot prove IDENTITY. A hand-rolled querySelector
 * in Node would only prove our matcher agrees with our matcher — the same class
 * of self-confirming test. jsdom would prove it in jsdom; the production
 * resolver runs in Chrome. Chrome's `querySelector` is the ground truth, and
 * this repo already runs headless Chromium in `npm test` (see
 * `smoke-register.ts`).
 *
 * This is the SECOND time a stubbed unit test passed while the feature was
 * wrong in a real browser. The first was the content-script registration relay.
 * See `.claude/rules/testing.md`.
 *
 * Run after `npm run build.server`:  npm run smoke.hints
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

// The server builds to CommonJS; this script is ESM. Load the BUILT output the
// way Node itself would, so this test exercises exactly what ships rather than
// a second copy of the page source.
const require_ = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Hard ceiling on the whole run, so a wedged browser cannot hang `npm test`. */
const DEADLINE_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  process.stderr.write(`\n✗ FAIL — ${message}\n`);
  process.exit(1);
}

function ok(message: string): void {
  process.stdout.write(`  ✓ ${message}\n`);
}

/**
 * The hostile fixture. No ids, no classes, repeated text, byte-identical twins,
 * and one element the ladder must NOT be able to name.
 *
 *   - three class-less <a> siblings          -> the news.ycombinator.com shape
 *   - two look-alike <div> cards             -> distinguishable only at depth 2
 *   - two byte-identical <li> siblings       -> distinguishable only positionally
 *   - one detached <div>                     -> distinguishable not at all
 */
const FIXTURE = `<!doctype html><meta charset="utf-8"><title>hints</title><body>
<span><a href="/news">Hacker News</a><a href="/newest">new</a><a href="/newcomments">comments</a></span>
<div><div><span>First card body</span></div></div>
<div><div><span>Second card body</span></div></div>
<ul><li></li><li></li></ul>
<script>
  // Tag every element a candidate sweep can reach, so identity can be asserted
  // in-page without serializing DOM nodes across CDP.
  var i = 0;
  document.querySelectorAll('*').forEach(function (el) { el.setAttribute('data-ss-probe', 'p' + (i++)); });

  // The rung-5 probe. This element is created and never appended, so
  // document.querySelector can never return it and no rung of the ladder can
  // round-trip to it. It is the only way to prove the bottom of the ladder
  // ("mint no handle") is still reachable.
  var detached = document.createElement('div');
  detached.setAttribute('data-ss-probe', 'detached');
  detached.textContent = 'unreachable detached card';
  window.__ssDetached = detached;
</script>
</body>`;

/** Serve the fixture on an ephemeral port. Every path returns the same page. */
async function serveFixture(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

/** Read the CDP port Chromium chose, written once it is listening. */
async function readDevToolsPort(userDataDir: string): Promise<number> {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(portFile)) {
      const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (first) return parseInt(first, 10);
    }
    await sleep(500);
  }
  fail('Chromium never reported a DevTools port. Is the binary usable headless?');
}

function cdpHttp(port: number, urlPath: string, method: 'GET' | 'PUT'): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A minimal CDP session over one target's WebSocket. */
async function cdpSession(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  ws.on('error', (err) => fail(`CDP socket error: ${err instanceof Error ? err.message : String(err)}`));

  let nextId = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    close: () => ws.close(),
    send,
    /** Evaluate an expression, awaiting promises, and return its value. */
    async evaluate<T = unknown>(expression: string): Promise<T> {
      const msg = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      const details = msg.result?.exceptionDetails;
      if (details) fail(`page threw: ${details.exception?.description || details.text}`);
      return msg.result?.result?.value as T;
    },
  };
}

/** What `describe` reports back, plus the in-page identity probe. */
interface Described {
  probe: string;
  selector: string;
  qualified: boolean;
  tag: string;
  text: string;
  matchText: string;
}

/** The result of re-resolving one described selector in the same page. */
interface RoundTripped {
  probe: string;
  selector: string;
  qualified: boolean;
  /** The probe attribute of whatever the selector actually resolved to. */
  landed: string | null;
}

async function main(): Promise<void> {
  process.stdout.write('smoke.hints — element-miss hint identity in real Chromium\n');

  const qualifyPath = path.join(REPO_ROOT, 'server', 'dist', 'tools', 'lib', 'selector-qualify.js');
  const describePath = path.join(REPO_ROOT, 'server', 'dist', 'tools', 'lib', 'element-resolver.js');
  if (!fs.existsSync(qualifyPath) || !fs.existsSync(describePath)) {
    fail('server/dist is missing the page sources — run `npm run build.server` first.');
  }
  const { QUALIFY_SOURCE } = require_(qualifyPath) as { QUALIFY_SOURCE?: string };
  const { DESCRIBE_SOURCE } = require_(describePath) as { DESCRIBE_SOURCE?: string };
  if (!QUALIFY_SOURCE || !DESCRIBE_SOURCE) {
    fail('server/dist no longer exports QUALIFY_SOURCE / DESCRIBE_SOURCE — rebuild, or the exports were renamed.');
  }

  const { findChromiumBinary } = require_(
    path.join(REPO_ROOT, 'daemon', 'dist', 'profiles', 'chrome.js'),
  ) as { findChromiumBinary: () => string | null };
  const binary = findChromiumBinary();
  if (!binary) fail('No Chromium binary found. SuperSurf needs one to run at all.');
  process.stdout.write(`Chromium:  ${binary}\n`);

  const fixture = await serveFixture();
  process.stdout.write(`Fixture:   ${fixture.url}\n`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-smoke-hints-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  // Registered on `exit`, which fires for a clean return AND for every
  // `fail()` (process.exit) path, so the browser and the temp profile never
  // outlive the test.
  const cleanup = () => {
    try { child.kill(); } catch { /* already gone */ }
    try { fixture.close(); } catch { /* already closed */ }
    // Chromium keeps writing to its profile as it dies, so the rmdir can lose a
    // race. A leftover temp directory is not a test failure.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* the OS will reap it from tmp */ }
  };
  process.on('exit', cleanup);

  const watchdog = setTimeout(
    () => fail(`timed out after ${DEADLINE_MS / 1000}s — Chromium never finished the round trip.`),
    DEADLINE_MS,
  );

  const cdpPort = await readDevToolsPort(userDataDir);
  const target = JSON.parse(await cdpHttp(cdpPort, `/json/new?${fixture.url}`, 'PUT'));
  if (!target?.webSocketDebuggerUrl) fail('Chromium would not open the fixture page.');
  const page = await cdpSession(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  // Real readiness signal, not a sleep: the fixture's own script has run when
  // the probes are on the DOM and the rung-5 element exists.
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await page.evaluate<boolean>(
      `document.readyState === 'complete' && !!document.querySelector('[data-ss-probe]') && !!window.__ssDetached`,
    ) === true;
    if (!ready) await sleep(100);
  }
  if (!ready) fail('the fixture page never finished loading its probe attributes.');

  // ---- Property 1: every described selector resolves to the element it describes.
  const describeAll = `
    (() => {
      ${QUALIFY_SOURCE}
      ${DESCRIBE_SOURCE}
      const out = [];
      for (const el of document.querySelectorAll('a, div, li, span')) {
        const d = describe(el, 0);
        out.push({
          probe: el.getAttribute('data-ss-probe'),
          selector: d.selector,
          qualified: d.qualified,
          tag: d.tag,
          text: d.text,
          matchText: d.matchText,
        });
      }
      return out;
    })()
  `;
  const described = await page.evaluate<Described[]>(describeAll);
  if (!Array.isArray(described) || described.length < 8) {
    fail(`the fixture produced only ${described?.length} candidates — expected at least 8. Did the fixture markup change?`);
  }
  ok(`described ${described.length} candidates`);

  // Re-resolve each selector with the SAME semantics the runtime uses, and
  // compare probe attributes — identity, not similarity.
  const roundTrip = `
    (() => {
      ${QUALIFY_SOURCE}
      const input = ${JSON.stringify(described)};
      return input.map((c) => {
        const hit = ssResolve(c.selector);
        return {
          probe: c.probe,
          selector: c.selector,
          qualified: c.qualified,
          landed: hit ? hit.getAttribute('data-ss-probe') : null,
        };
      });
    })()
  `;
  const results = await page.evaluate<RoundTripped[]>(roundTrip);

  const drifted = results.filter((r) => r.qualified && r.landed !== r.probe);
  if (drifted.length) {
    fail(
      `${drifted.length} qualified selector(s) resolved to a DIFFERENT element:\n` +
        drifted
          .map((d) => `    ${d.selector}  described ${d.probe}, resolved ${d.landed}`)
          .join('\n') +
        '\n  A qualified selector is bound as an @handle, so this is a silent wrong-element click.',
    );
  }
  const qualifiedCount = results.filter((r) => r.qualified).length;
  if (qualifiedCount === 0) fail('nothing qualified at all — the ladder never verified a single selector.');
  ok(`all ${qualifiedCount} qualified selectors round-trip to their own element`);

  // ---- Property 2: the class-less anchors all qualify (the HN case).
  const anchors = results.filter((r) => r.selector === 'a' || r.selector.startsWith('a:') || r.selector.startsWith('a['));
  if (anchors.length !== 3) {
    fail(`expected 3 class-less anchors, described ${anchors.length}: ${anchors.map((a) => a.selector).join(', ')}`);
  }
  const unqualifiedAnchors = anchors.filter((a) => !a.qualified);
  if (unqualifiedAnchors.length) {
    fail(
      `class-less anchors failed to qualify: ${unqualifiedAnchors.map((a) => a.selector).join(', ')} — ` +
        'each has distinct direct text, so rung 1 must name them.',
    );
  }
  if (new Set(anchors.map((a) => a.selector)).size !== anchors.length) {
    fail(
      `anchors produced duplicate selectors: ${anchors.map((a) => a.selector).join(', ')} — ` +
        'this is the exact news.ycombinator.com defect.',
    );
  }
  ok('class-less anchors each qualify to a distinct selector');

  // ---- Property 3a: byte-identical twins qualify to DISTINCT selectors.
  //
  // The plan's brief expected these to come back unqualified. That is wrong
  // against the ladder itself: rung 0 names the first twin (`document
  // .querySelector('li')` IS it) and rung 4's anchored positional path names
  // the second. Disambiguating them is the stronger, correct property.
  const twins = described.filter((c) => c.tag === 'li');
  if (twins.length !== 2) fail(`expected 2 <li> twins in the fixture, found ${twins.length}.`);
  const vagueTwins = twins.filter((t) => !t.qualified);
  if (vagueTwins.length) {
    fail(
      `${vagueTwins.length} of the 2 byte-identical <li> twins failed to qualify — ` +
        "rung 0 must name the first and rung 4's anchored positional path must name the second.",
    );
  }
  if (twins[0].selector === twins[1].selector) {
    fail(
      `both <li> twins qualified to the SAME selector "${twins[0].selector}" — ` +
        'the ladder did not disambiguate byte-identical siblings, so one handle would click the wrong row.',
    );
  }
  const twinProbes = new Set(twins.map((t) => t.probe));
  const twinDrift = results.filter((r) => twinProbes.has(r.probe) && r.landed !== r.probe);
  if (twinDrift.length) {
    fail(
      'a <li> twin selector resolved to the other twin:\n' +
        twinDrift.map((d) => `    ${d.selector}  described ${d.probe}, resolved ${d.landed}`).join('\n'),
    );
  }
  ok(`byte-identical twins qualify to distinct selectors (${twins[0].selector} / ${twins[1].selector})`);

  // ---- Property 3b: rung 5 (mint no handle) is still reachable.
  //
  // Nothing in the document can prove this — the anchored positional path can
  // name any attached element. A detached element can never be returned by
  // document.querySelector, so every rung must fail on it.
  const detached = await page.evaluate<{ selector: string; qualified: boolean; inDocument: boolean }>(`
    (() => {
      ${QUALIFY_SOURCE}
      ${DESCRIBE_SOURCE}
      const el = window.__ssDetached;
      const d = describe(el, 0);
      return { selector: d.selector, qualified: d.qualified, inDocument: document.contains(el) };
    })()
  `);
  if (detached.inDocument) {
    fail('the rung-5 probe element is attached to the document — the fixture no longer tests rung 5.');
  }
  if (detached.qualified) {
    fail(
      `an unreachable detached element was qualified to "${detached.selector}" — ` +
        'rung 5 (mint no handle) is unreachable, so the ladder can never honestly decline.',
    );
  }
  ok('an unreachable element falls off the ladder — rung 5 reachable, no handle minted');

  // ---- Property 4: a real click lands on the intended anchor.
  const secondAnchor = described.find((c) => c.matchText === 'new');
  if (!secondAnchor) fail('the fixture anchor with text "new" was not described.');
  // The listener calls preventDefault so the anchor's href cannot navigate the
  // page out from under the pending CDP response. Which element received the
  // click is unaffected — that is the whole property.
  const clickResult = await page.evaluate<string | null>(`
    (() => {
      ${QUALIFY_SOURCE}
      const el = ssResolve(${JSON.stringify(secondAnchor.selector)});
      if (!el) return 'no-match';
      let landed = null;
      el.addEventListener('click', function (e) {
        landed = e.currentTarget.getAttribute('data-ss-probe');
        e.preventDefault();
      }, { once: true, capture: true });
      el.click();
      return landed;
    })()
  `);
  if (clickResult !== secondAnchor.probe) {
    fail(
      `a click on ${secondAnchor.selector} landed on ${clickResult}, expected ${secondAnchor.probe} ` +
        `(the anchor whose text is "${secondAnchor.matchText}").`,
    );
  }
  ok(`a real click on ${secondAnchor.selector} reached the intended anchor`);

  clearTimeout(watchdog);
  page.close();
  process.stdout.write('\n✓ smoke.hints passed\n');
  process.exit(0);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
