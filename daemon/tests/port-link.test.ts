import { describe, it, expect, afterEach, vi } from 'vitest';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { PortLinkRouter, type PortLink } from '../src/engine-worker/port-link';
import type { MainToWorker, WorkerToMain } from '../src/engine-worker/protocol';

const ACK = {
  type: 'session_ack', browser: 'brave', buildTimestamp: 'bt1', version: '9.9.9',
  extensionConnected: true, extensionVersionError: 'too old', activeSessionCount: 3,
};

interface Rig {
  router: PortLinkRouter;
  seen: WorkerToMain[];
  /** Post a main-to-worker message and let the worker side receive it. */
  send(m: MainToWorker): Promise<void>;
  /** Main's answer to every `link-open` (default: ack). */
  onOpen: (m: Extract<WorkerToMain, { t: 'link-open' }>) => void;
  /** Main's answer to every `req` (default: nothing). */
  onReq: (m: Extract<WorkerToMain, { t: 'req' }>) => void;
}

const ports: MessagePort[] = [];
function rig(): Rig {
  const { port1: workerSide, port2: mainSide } = new MessageChannel();
  ports.push(workerSide, mainSide);
  const router = new PortLinkRouter(workerSide);
  workerSide.on('message', (m: MainToWorker) => router.handle(m));
  const r: Rig = {
    router,
    seen: [],
    send: (m) => new Promise((resolve) => { mainSide.postMessage(m); setTimeout(resolve, 20); }),
    onOpen: (m) => mainSide.postMessage({ t: 'msg', lid: m.lid, msg: ACK }),
    onReq: () => {},
  };
  mainSide.on('message', (m: WorkerToMain) => {
    r.seen.push(m);
    if (m.t === 'link-open') r.onOpen(m);
    if (m.t === 'req') r.onReq(m);
  });
  return r;
}

afterEach(() => {
  vi.useRealTimers();
  for (const p of ports.splice(0)) p.close();
});

const reply = (r: Rig, m: { lid: number; msg: { id: string } }, extra: object) =>
  r.send({ t: 'msg', lid: m.lid, msg: { jsonrpc: '2.0', id: m.msg.id, ...extra } });

describe('PortLink', () => {
  it('open posts link-open with the session id and mirrors the ack', async () => {
    const r = rig();
    const link = await r.router.open('alice');
    expect(r.seen[0]).toMatchObject({ t: 'link-open', sessionId: 'alice' });
    expect(link.connected).toBe(true);
    expect(link.browser).toBe('brave');
    expect(link.buildTime).toBe('bt1');
    expect(link.version).toBe('9.9.9');
    expect(link.extensionConnected).toBe(true);
    expect(link.extensionVersionError).toBe('too old');
    expect(link.activeSessionCount).toBe(3);
    expect(link.spawnReason).toBeUndefined();
  });

  it('a bare ack leaves the defaults (pre-upgrade daemon)', async () => {
    const r = rig();
    r.onOpen = (m) => void r.send({ t: 'msg', lid: m.lid, msg: { type: 'session_ack' } });
    const link = await r.router.open('a');
    expect(link.browser).toBe('chrome');
    expect(link.version).toBeNull();
    expect(link.extensionConnected).toBe(false);
    expect(link.activeSessionCount).toBeNull();
    expect(link.extensionVersionError).toBeNull();
  });

  it('rejects open on session_reject with the reason', async () => {
    const r = rig();
    r.onOpen = (m) => void r.send({ t: 'msg', lid: m.lid, msg: { type: 'session_reject', reason: 'name taken' } });
    await expect(r.router.open('dup')).rejects.toThrow('name taken');
  });

  it('rejects open when no ack arrives within 10 s', async () => {
    const r = rig();
    r.onOpen = () => {};
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = r.router.open('slow');
    const assertion = expect(p).rejects.toThrow('Timeout connecting to daemon');
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    vi.useRealTimers();
    await new Promise((res) => setTimeout(res, 30));
    // Main registered the session on link-open; without a link-close it would leak.
    expect(r.seen.filter((m) => m.t === 'link-close')).toEqual([{ t: 'link-close', lid: 1 }]);
  });

  it('sendCmd posts a req and resolves with the result', async () => {
    const r = rig();
    const link = await r.router.open('a');
    r.onReq = (m) => void reply(r, m, { result: { ok: 1 } });
    await expect(link.sendCmd('tabs.list', { x: 1 }, 5000)).resolves.toEqual({ ok: 1 });
    const req = r.seen.find((m) => m.t === 'req') as Extract<WorkerToMain, { t: 'req' }>;
    expect(req.msg).toMatchObject({ jsonrpc: '2.0', method: 'tabs.list', params: { x: 1 }, timeout: 5000 });
    expect(req.lid).toBe(link.lid);
  });

  it('sendCmd rejects with the error message', async () => {
    const r = rig();
    const link = await r.router.open('a');
    r.onReq = (m) => void reply(r, m, { error: { code: -1, message: 'boom' } });
    await expect(link.sendCmd('x')).rejects.toThrow('boom');
  });

  it('sendCmd times out', async () => {
    const r = rig();
    const link = await r.router.open('a');
    await expect(link.sendCmd('slow_method', {}, 30)).rejects.toThrow('Request timeout: slow_method');
  });

  it('sendCmd before the ack is refused', async () => {
    const r = rig();
    r.onOpen = () => {};
    const p = r.router.open('a');
    p.catch(() => {});
    // the only link is lid 1, not yet connected
    const early = (r.router as any).links.get(1) as PortLink;
    await expect(early.sendCmd('x')).rejects.toThrow('Not connected to daemon');
  });

  it('pipes currentTab to the callback and buffers _dialogs, stripped from the result', async () => {
    const r = rig();
    const link = await r.router.open('a');
    const tabs: unknown[] = [];
    link.onTabInfoUpdate = (t) => tabs.push(t);
    const dlg = { type: 'alert', message: 'hi', defaultPrompt: '', url: 'u', hasBrowserHandler: false, timestamp: 1 };
    r.onReq = (m) => void reply(r, m, { result: { value: 5, currentTab: { id: 9 }, _dialogs: [dlg] } });
    const result = await link.sendCmd('x');
    expect(tabs).toEqual([{ id: 9 }]);
    expect(result).not.toHaveProperty('_dialogs');
    expect(link.consumeDialogEvents()).toEqual([dlg]);
    expect(link.consumeDialogEvents()).toEqual([]);
  });

  it('config_drift and peers update from a later response', async () => {
    const r = rig();
    const link = await r.router.open('a');
    expect(link.isConfigDrifted()).toBe(false);
    expect(link.getPeerSessions()).toEqual([]);
    r.onReq = (m) => void reply(r, m, { result: {}, config_drift: true, peers: ['bob'] });
    await link.sendCmd('x');
    expect(link.isConfigDrifted()).toBe(true);
    expect(link.getPeerSessions()).toEqual(['bob']);
  });

  it('ack config_drift and peers are mirrored too', async () => {
    const r = rig();
    r.onOpen = (m) => void r.send({ t: 'msg', lid: m.lid, msg: { ...ACK, config_drift: true, peers: ['carol'] } });
    const link = await r.router.open('a');
    expect(link.isConfigDrifted()).toBe(true);
    expect(link.getPeerSessions()).toEqual(['carol']);
  });

  it('stop posts link-close, rejects in-flight and disconnects', async () => {
    const r = rig();
    const link = await r.router.open('a');
    const pending = link.sendCmd('x', {}, 5000);
    const assertion = expect(pending).rejects.toThrow('Daemon connection closed');
    await link.stop();
    await assertion;
    await r.send({ t: 'shutdown' }); // let the port drain
    expect(r.seen).toContainEqual({ t: 'link-close', lid: link.lid });
    expect(link.connected).toBe(false);
    await expect(link.sendCmd('y')).rejects.toThrow('Not connected');
  });

  it('link-end rejects in-flight, disconnects, and posts no link-close', async () => {
    const r = rig();
    const link = await r.router.open('a');
    const pending = link.sendCmd('x', {}, 5000);
    const assertion = expect(pending).rejects.toThrow('Daemon connection closed');
    await r.send({ t: 'link-end', lid: link.lid });
    await assertion;
    expect(link.connected).toBe(false);
    await link.stop();
    await r.send({ t: 'shutdown' });
    expect(r.seen.some((m) => m.t === 'link-close')).toBe(false);
  });

  it('two links on one port route independently', async () => {
    const r = rig();
    const a = await r.router.open('a');
    const b = await r.router.open('b');
    expect(a.lid).not.toBe(b.lid);
    r.onReq = (m) => void reply(r, m, { result: { for: m.lid }, peers: [`peer-of-${m.lid}`] });
    const [ra, rb] = await Promise.all([a.sendCmd('x'), b.sendCmd('x')]);
    expect(ra).toEqual({ for: a.lid });
    expect(rb).toEqual({ for: b.lid });
    expect(a.getPeerSessions()).toEqual([`peer-of-${a.lid}`]);
    expect(b.getPeerSessions()).toEqual([`peer-of-${b.lid}`]);

    await r.send({ t: 'link-end', lid: a.lid });
    expect(a.connected).toBe(false);
    expect(b.connected).toBe(true);
    await expect(b.sendCmd('x')).resolves.toEqual({ for: b.lid });
  });

  it('handle returns false for messages that are not link messages', () => {
    const router = new PortLinkRouter({ postMessage() {} });
    expect(router.handle({ t: 'shutdown' })).toBe(false);
    expect(router.handle({ t: 'msg', lid: 99, msg: {} })).toBe(true);
  });
});
