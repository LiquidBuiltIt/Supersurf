import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { ExtensionBridge } from '../src/extension-bridge';

// R1 regression lock (coordinator ruling): when the extension version guard
// CANNOT run for a connection, the daemon must be LOUD — console.error, not
// just debugLog — because a silently-off guard reads as a guard that passed.
// A patch-level `warn` verdict is the guard PASSING and must stay
// debugLog-only. Nothing previously asserted that console.error actually
// fires (or doesn't); this file drives a real ExtensionBridge + real `ws`
// client over the handshake wire to lock it.

// Use a range of ports to avoid conflicts between tests in this file.
let portCounter = 9600;
function nextPort(): number {
  return portCounter++;
}

function connectClient(port: number): { ws: WebSocket; ready: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return { ws, ready };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block until the bridge has actually PROCESSED a handshake, and return the
 * pooled connection it produced.
 *
 * A fixed sleep is not a sync point. The negative test below asserts
 * console.error was NOT called, and with a bare `await wait(50)` it passes
 * just as happily when the handshake never arrived at all — deleting the
 * `ws.send()` outright left all three tests green. `versionStatus` leaves
 * 'pending' only once the guard has run, so it is the real signal.
 */
async function waitForHandshake(b: ExtensionBridge, timeoutMs = 2000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const conn of ((b as any).matchmaker as any)['pool'].values()) {
      if (conn.versionStatus !== 'pending') return conn;
    }
    await wait(5);
  }
  throw new Error('handshake was never processed');
}

describe('ExtensionBridge — extension version guard stderr escalation (R1)', () => {
  let bridge: ExtensionBridge;
  let port: number;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const clients: WebSocket[] = [];

  beforeEach(async () => {
    port = nextPort();
    bridge = new ExtensionBridge(port, '127.0.0.1', '3.4.0');
    await bridge.start();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN || c.readyState === WebSocket.CONNECTING) {
        c.close();
      }
    }
    clients.length = 0;
    await bridge.stop();
  });

  it('emits console.error when the handshake version is unparsable and the guard cannot run', async () => {
    const { ws, ready } = connectClient(port);
    clients.push(ws);
    await ready;

    ws.send(JSON.stringify({ type: 'handshake', browser: 'chrome', version: 'not-a-version' }));
    const conn = await waitForHandshake(bridge);

    expect(conn.version).toBe('not-a-version');
    expect(errorSpy).toHaveBeenCalled();
    const calls = errorSpy.mock.calls.map((args) => args.join(' '));
    expect(calls.some((line) => line.includes('guard inactive'))).toBe(true);
    expect(calls.some((line) => line.includes('not-a-version'))).toBe(true);
  });

  it('does NOT emit console.error for a patch-level warn — that is the guard passing', async () => {
    const { ws, ready } = connectClient(port);
    clients.push(ws);
    await ready;

    // Daemon is 3.4.0, extension reports 3.4.1 — patch-only skew, status
    // 'warn' but guardActive stays true. debugLog-only, per R1.
    ws.send(JSON.stringify({ type: 'handshake', browser: 'chrome', version: '3.4.1' }));
    const conn = await waitForHandshake(bridge);

    // Prove the handshake actually landed before asserting the negative.
    expect(conn.version).toBe('3.4.1');
    expect(conn.versionStatus).toBe('warn');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('emits console.error when the handshake omits the version field entirely', async () => {
    const { ws, ready } = connectClient(port);
    clients.push(ws);
    await ready;

    ws.send(JSON.stringify({ type: 'handshake', browser: 'chrome' }));
    const conn = await waitForHandshake(bridge);

    expect(conn.version).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    const calls = errorSpy.mock.calls.map((args) => args.join(' '));
    expect(calls.some((line) => line.includes('guard inactive'))).toBe(true);
  });
});
