import { describe, it, expect, vi } from 'vitest';
import { SessionContext } from '../src/session-context.js';
import { TabHandlers } from '../src/handlers/tabs.js';
import { DialogHandler, clearDialogForTab } from '../src/handlers/dialogs.js';
import { NetworkTracker, getRequestsForSession } from '../src/handlers/network.js';
import { createMockChrome } from './__mocks__/chrome.js';

// Construction copied from tests/handlers/tabs.test.ts — do not invent a
// second pattern for building a TabHandlers under test.
function createMockLogger() {
  return {
    log: vi.fn(),
    logAlways: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    setDebugMode: vi.fn(),
  } as any;
}

function createMockIconManager() {
  return {
    init: vi.fn(),
    setConnected: vi.fn(),
    setAttachedTab: vi.fn(),
    setStealthMode: vi.fn(),
    updateBadgeForTab: vi.fn(),
    updateBadge: vi.fn(),
    clearBadge: vi.fn(),
    setGlobalIcon: vi.fn(),
    updateConnectingBadge: vi.fn(),
  } as any;
}

function makeTabHandlers(chrome: ReturnType<typeof createMockChrome>, ctx: SessionContext): TabHandlers {
  return new TabHandlers(chrome, createMockLogger(), createMockIconManager(), ctx);
}

describe('SessionContext — two sessions do not alias', () => {
  it('keeps attachedTabId separate per session id', () => {
    const ctx = new SessionContext();
    ctx.getSession('sm-a').attachedTabId = 101;
    ctx.getSession('sm-b').attachedTabId = 202;
    expect(ctx.getSession('sm-a').attachedTabId).toBe(101);
    expect(ctx.getSession('sm-b').attachedTabId).toBe(202);
  });

  it('exposes every live session so tab-close cleanup can sweep them all', () => {
    const ctx = new SessionContext();
    ctx.getSession('sm-a').attachedTabId = 101;
    ctx.getSession('sm-b').attachedTabId = 202;
    const ids = ctx.sessionEntries().map(([id]) => id).sort();
    expect(ids).toEqual(['sm-a', 'sm-b']);
  });

  it('has no global attached-tab accessor left to alias through', () => {
    // The defect was a convenience accessor resolving the null key. Its
    // absence is the invariant; a property descriptor is how we assert it
    // without a compile step.
    const proto = Object.getPrototypeOf(new SessionContext());
    expect(Object.getOwnPropertyDescriptor(proto, 'attachedTabId')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(proto, 'stealthMode')).toBeUndefined();
  });
});

describe('TabHandlers — two sessions own different tabs', () => {
  it('createTab records the tab against the calling session only', async () => {
    const chrome = createMockChrome();
    const ctx = new SessionContext();
    const handlers = makeTabHandlers(chrome, ctx);

    const a = await handlers.createTab({ url: 'http://a.test/', _sessionId: 'sm-a' });
    const b = await handlers.createTab({ url: 'http://b.test/', _sessionId: 'sm-b' });

    expect(a.attachedTab.id).not.toBe(b.attachedTab.id);
    expect(handlers.getAttachedTabId('sm-a')).toBe(a.attachedTab.id);
    expect(handlers.getAttachedTabId('sm-b')).toBe(b.attachedTab.id);
  });

  it('closing one session\'s tab does not clear the other\'s pointer', async () => {
    const chrome = createMockChrome();
    const ctx = new SessionContext();
    const handlers = makeTabHandlers(chrome, ctx);

    const a = await handlers.createTab({ url: 'http://a.test/', _sessionId: 'sm-a' });
    const b = await handlers.createTab({ url: 'http://b.test/', _sessionId: 'sm-b' });

    handlers.handleTabClosed(b.attachedTab.id);

    expect(handlers.getAttachedTabId('sm-a')).toBe(a.attachedTab.id);
    expect(handlers.getAttachedTabId('sm-b')).toBeNull();
  });
});

describe('SessionContext — CDP attachment is per tab', () => {
  it('tracks two attached tabs at once', () => {
    const ctx = new SessionContext();
    ctx.markDebuggerAttached(101);
    ctx.markDebuggerAttached(202);
    expect(ctx.isDebuggerAttached(101)).toBe(true);
    expect(ctx.isDebuggerAttached(202)).toBe(true);
  });

  it('detaching one tab leaves the other attached', () => {
    const ctx = new SessionContext();
    ctx.markDebuggerAttached(101);
    ctx.markDebuggerAttached(202);
    ctx.markDebuggerDetached(202);
    expect(ctx.isDebuggerAttached(101)).toBe(true);
    expect(ctx.isDebuggerAttached(202)).toBe(false);
  });
});

describe('DialogHandler — one dialog per tab', () => {
  it('holds two tabs\' dialogs at once without overwriting', () => {
    const h = new DialogHandler({} as any, { log: () => {} } as any);
    h.onDialogOpening(101, { type: 'confirm', message: 'A?' });
    h.onDialogOpening(202, { type: 'alert', message: 'B!' });

    expect(h.getPending(101)?.message).toBe('A?');
    expect(h.getPending(202)?.message).toBe('B!');
    expect(h.getPending(101)?.tabId).toBe(101);
  });

  it('clearing one tab leaves the other held', () => {
    const h = new DialogHandler({} as any, { log: () => {} } as any);
    h.onDialogOpening(101, { type: 'confirm', message: 'A?' });
    h.onDialogOpening(202, { type: 'alert', message: 'B!' });
    h.clearPending(202);
    expect(h.getPending(101)?.message).toBe('A?');
    expect(h.getPending(202)).toBeNull();
  });
});

describe('SessionContext — a dialog blocks only its own session', () => {
  it('does not report pending for a session with no dialog', () => {
    const ctx = new SessionContext();
    ctx.getSession('sm-b').dialogPendingTabs.add(202);
    expect(ctx.getSession('sm-a').dialogPendingTabs.size).toBe(0);
    expect(ctx.getSession('sm-b').dialogPendingTabs.has(202)).toBe(true);
  });
});

describe('clearDialogForTab — detaching one tab does not clear another tab\'s pending dialog', () => {
  it('sweeping tab B\'s dialog off every session leaves tab A\'s session flagged', () => {
    const h = new DialogHandler({} as any, { log: () => {} } as any);
    const ctx = new SessionContext();
    h.onDialogOpening(101, { type: 'alert', message: 'A' });
    h.onDialogOpening(202, { type: 'alert', message: 'B' });
    ctx.getSession('sm-a').dialogPendingTabs.add(101);
    ctx.getSession('sm-b').dialogPendingTabs.add(202);

    // Calls the SAME function background.ts's onDetach listener delegates
    // to for tab 202 only — the site that used to clear a single global flag
    // for every session.
    clearDialogForTab(h, ctx, 202);

    expect(h.getPending(101)?.message).toBe('A');
    expect(h.getPending(202)).toBeNull();
    expect(ctx.getSession('sm-a').dialogPendingTabs.has(101)).toBe(true);
    expect(ctx.getSession('sm-b').dialogPendingTabs.has(202)).toBe(false);
  });
});

describe('networkRequests — a session with no attached tab reads nobody else\'s log', () => {
  // The scoping added by this branch had a hole: getAttachedTabId returns null
  // for a session that has not attached yet, and null is getRequests' every-tab
  // diagnostics sentinel — so session B calling browser_network_requests before
  // attaching was handed session A's entire capture, headers and bodies
  // included. getRequestsForSession IS the command handler's body.
  function setup() {
    const chrome = createMockChrome();
    const ctx = new SessionContext();
    const tabs = makeTabHandlers(chrome, ctx);
    const tracker = new NetworkTracker(chrome, createMockLogger());
    tracker.init();
    for (const [tabId, requestId, url] of [[7, 'a', 'https://a.test/'], [9, 'b', 'https://b.test/']] as const) {
      chrome.webRequest.onBeforeRequest._fire({
        requestId, tabId, url, method: 'GET', type: 'main_frame', timeStamp: 1,
      });
    }
    ctx.getSession('sm-a').attachedTabId = 7;
    return { tabs, tracker };
  }

  it('gives an attached session only its own tab\'s requests', () => {
    const { tabs, tracker } = setup();
    expect(getRequestsForSession(tracker, tabs, 'sm-a').map((r) => r.url)).toEqual(['https://a.test/']);
  });

  it('throws for a session with no attached tab instead of returning the other session\'s', () => {
    const { tabs, tracker } = setup();
    expect(() => getRequestsForSession(tracker, tabs, 'sm-b')).toThrow(/No tab is attached/);
    // Belt and braces: the failure mode was silently receiving A's records.
    let leaked: unknown[] = [];
    try { leaked = getRequestsForSession(tracker, tabs, 'sm-b'); } catch { /* expected */ }
    expect(leaked).toEqual([]);
  });
});
