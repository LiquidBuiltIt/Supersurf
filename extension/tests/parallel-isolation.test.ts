import { describe, it, expect, vi } from 'vitest';
import { SessionContext } from '../src/session-context.js';
import { TabHandlers } from '../src/handlers/tabs.js';
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
