/**
 * Smoke test — managed-profile registration, end to end in a real browser.
 *
 * Serves the daemon's own `/register/:name` page, loads the built extension into
 * a throwaway headless Chromium, and asserts the full round trip:
 *
 *   page  --postMessage-->  content script  --sendMessage-->  service worker
 *   page  <--ack---------   content script  <--{ok:true}----  chrome.storage
 *
 * Why this exists as a browser test rather than a unit test: MV3 content scripts
 * are classic scripts, so `extension/src/content-script.ts` cannot export
 * anything and cannot be imported by Vitest. More to the point, the stubbed unit
 * test this replaced passed every assertion while the feature was completely
 * dead in Chrome — a stray `import` in the compiled content script made Chrome
 * refuse to parse the file at all. Only a real browser catches that class of
 * defect, so only a real browser is trusted with it.
 *
 * Run after `npm run build`:  npm run smoke.register
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

// The daemon builds to CommonJS; this script is ESM. Load its output the way
// Node itself would rather than duplicating the page HTML or the binary search.
const require_ = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = path.join(REPO_ROOT, 'extension');
const PROFILE_NAME = 'smoketest';

/** How long the whole round trip may take. The page's own timeout is 15 s. */
const ROUND_TRIP_TIMEOUT_MS = 25_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error(`\n✗ FAIL — ${message}`);
  process.exit(1);
}

/** Serve the daemon's real registration HTML on an ephemeral port. */
async function serveRegistrationPage(): Promise<{ port: number; close: () => void }> {
  const pagePath = path.join(REPO_ROOT, 'daemon', 'dist', 'profiles', 'registration-page.js');
  if (!fs.existsSync(pagePath)) {
    fail(`${path.relative(REPO_ROOT, pagePath)} is missing. Run \`npm run build\` first.`);
  }
  const { registrationHtml } = require_(pagePath) as { registrationHtml: (n: string) => string };

  const server = http.createServer((req, res) => {
    const match = req.url?.match(/^\/register\/([a-z0-9][a-z0-9-]*)$/);
    if (!match) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(registrationHtml(match[1]));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => server.close() };
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
function cdpSession(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
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
    ready: new Promise<void>((resolve) => ws.on('open', () => resolve())),
    close: () => ws.close(),
    /** Evaluate an expression, awaiting promises, and return its value. */
    async evaluate<T = unknown>(expression: string): Promise<T> {
      const res = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.result?.exceptionDetails) {
        fail(`page threw: ${res.result.exceptionDetails.text}`);
      }
      return res.result?.result?.value as T;
    },
  };
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'dist', 'content-script.js'))) {
    fail('extension/dist is missing. Run `npm run build` first.');
  }

  const { findChromiumBinary } = require_(
    path.join(REPO_ROOT, 'daemon', 'dist', 'profiles', 'chrome.js'),
  ) as { findChromiumBinary: () => string | null };

  const binary = findChromiumBinary();
  if (!binary) fail('No Chromium binary found. SuperSurf needs one to run at all.');
  console.log(`Chromium:  ${binary}`);

  const page = await serveRegistrationPage();
  const registerUrl = `http://127.0.0.1:${page.port}/register/${PROFILE_NAME}`;
  console.log(`Page:      ${registerUrl}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-smoke-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      `--user-data-dir=${userDataDir}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--disable-extensions-except=${EXTENSION_DIR}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  child.stderr.on('data', () => { /* Chromium is noisy on stderr even when healthy */ });

  const cleanup = () => {
    child.kill();
    page.close();
    // Chromium keeps writing to its profile as it dies, so the rmdir can lose a
    // race. A leftover temp directory is not a test failure — swallow it rather
    // than turning a passing round trip into a red exit.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will reap it from tmp */
    }
  };
  process.on('exit', cleanup);

  const cdpPort = await readDevToolsPort(userDataDir);

  // Give the service worker a moment to register its message listener, then
  // open the page fresh — a page that loads before the extension is ready is a
  // startup race, not the contract under test.
  await sleep(3000);

  const target = JSON.parse(await cdpHttp(cdpPort, `/json/new?${registerUrl}`, 'PUT'));
  const session = cdpSession(target.webSocketDebuggerUrl);
  await session.ready;

  console.log('\nWaiting for the registration round trip...');
  const deadline = Date.now() + ROUND_TRIP_TIMEOUT_MS;
  let className = '';
  while (Date.now() < deadline) {
    // The tab can be polled before the parser reaches <body>, so guard the read.
    className = await session.evaluate<string>('(document.body && document.body.className) || ""');
    if (className.includes('is-ready') || className.includes('is-failed')) break;
    await sleep(500);
  }

  if (!className.includes('is-ready')) {
    console.error(`  page state: "${className || '(still pending)'}"`);
    fail(
      'the registration page never reached its ready state. The content script ' +
      'relay, the background listener, or the ack path is broken.',
    );
  }
  console.log('  ✓ page reached is-ready');

  // The page state alone is not proof — assert the binding actually landed.
  const targets = JSON.parse(await cdpHttp(cdpPort, '/json/list', 'GET'));
  const worker = targets.find((t: { type: string }) => t.type === 'service_worker');
  if (!worker) fail('the extension service worker is not running.');

  const workerSession = cdpSession(worker.webSocketDebuggerUrl);
  await workerSession.ready;
  const stored = await workerSession.evaluate<string>(
    "chrome.storage.local.get('supersurf_profile').then(o => o.supersurf_profile ?? '')",
  );
  if (stored !== PROFILE_NAME) {
    fail(`chrome.storage.local.supersurf_profile is "${stored}", expected "${PROFILE_NAME}".`);
  }
  console.log(`  ✓ chrome.storage.local bound to "${stored}"`);

  session.close();
  workerSession.close();
  console.log('\n✓ PASS — registration round trip completed in a real browser.');

  // The HTTP server and Chromium both hold the event loop open. Nothing is
  // left to wait for, so leave rather than idling until someone notices.
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
