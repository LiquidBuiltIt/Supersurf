import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionContext } from '../src/session-context';

/** Create a mock chrome object with a working chrome.storage.session. */
function createMockChrome() {
  const store: Record<string, any> = {};
  return {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, any>) => {
          for (const [k, v] of Object.entries(obj)) store[k] = v;
        }),
        remove: vi.fn(async (key: string) => { delete store[key]; }),
      },
    },
    _store: store,
  } as any;
}

describe('SessionContext', () => {
  let ctx: SessionContext;

  beforeEach(() => {
    ctx = new SessionContext();
  });

  describe('global state', () => {
    it('defaults connected to false', () => {
      expect(ctx.connected).toBe(false);
    });

    it('defaults debuggerAttached to false', () => {
      expect(ctx.debuggerAttached).toBe(false);
    });

    it('defaults currentDebuggerTabId to null', () => {
      expect(ctx.currentDebuggerTabId).toBeNull();
    });

    it('allows setting global state', () => {
      ctx.connected = true;
      ctx.debuggerAttached = true;
      ctx.currentDebuggerTabId = 42;

      expect(ctx.connected).toBe(true);
      expect(ctx.debuggerAttached).toBe(true);
      expect(ctx.currentDebuggerTabId).toBe(42);
    });
  });

  describe('getSession()', () => {
    it('creates a session lazily on first access', () => {
      const session = ctx.getSession('session-1');
      expect(session).toBeDefined();
      expect(session.attachedTabId).toBeNull();
      expect(session.stealthMode).toBe(false);
      expect(session.stealthTabs).toBeInstanceOf(Map);
      expect(session.cursorPositions).toBeInstanceOf(Map);
      expect(session.humanizationConfig.enabled).toBe(false);
    });

    it('returns the same session on repeated access', () => {
      const s1 = ctx.getSession('session-1');
      const s2 = ctx.getSession('session-1');
      expect(s1).toBe(s2);
    });

    it('isolates different sessions', () => {
      const s1 = ctx.getSession('session-1');
      const s2 = ctx.getSession('session-2');
      expect(s1).not.toBe(s2);

      s1.attachedTabId = 10;
      s2.attachedTabId = 20;
      expect(s1.attachedTabId).toBe(10);
      expect(s2.attachedTabId).toBe(20);
    });

    it('uses null key for default/single-client session', () => {
      const defaultSession = ctx.getSession();
      const nullSession = ctx.getSession(null);
      expect(defaultSession).toBe(nullSession);
    });
  });

  describe('deleteSession()', () => {
    it('removes a session', () => {
      const s = ctx.getSession('temp');
      s.attachedTabId = 99;

      ctx.deleteSession('temp');

      // Getting it again creates a fresh session
      const s2 = ctx.getSession('temp');
      expect(s2.attachedTabId).toBeNull();
      expect(s2).not.toBe(s);
    });
  });

  describe('convenience accessors', () => {
    it('attachedTabId delegates to null-key session', () => {
      expect(ctx.attachedTabId).toBeNull();

      ctx.attachedTabId = 42;
      expect(ctx.attachedTabId).toBe(42);
      expect(ctx.getSession().attachedTabId).toBe(42);
    });

    it('stealthMode delegates to null-key session', () => {
      expect(ctx.stealthMode).toBe(false);

      ctx.stealthMode = true;
      expect(ctx.stealthMode).toBe(true);
      expect(ctx.getSession().stealthMode).toBe(true);
    });

    it('stealthTabs delegates to null-key session', () => {
      const tabs = ctx.stealthTabs;
      expect(tabs).toBeInstanceOf(Map);

      tabs.set(1, true);
      expect(ctx.getSession().stealthTabs.get(1)).toBe(true);
    });

    it('cursorPositions delegates to null-key session', () => {
      const positions = ctx.cursorPositions;
      expect(positions).toBeInstanceOf(Map);

      positions.set(1, { x: 100, y: 200 });
      expect(ctx.getSession().cursorPositions.get(1)).toEqual({ x: 100, y: 200 });
    });

    it('humanizationConfig delegates to null-key session', () => {
      expect(ctx.humanizationConfig.enabled).toBe(false);

      ctx.humanizationConfig = { enabled: true };
      expect(ctx.humanizationConfig.enabled).toBe(true);
      expect(ctx.getSession().humanizationConfig.enabled).toBe(true);
    });
  });

  describe('persistence', () => {
    it('persists state to chrome.storage.session on mutation', async () => {
      const mockChrome = createMockChrome();
      const pCtx = new SessionContext();
      await pCtx.init(mockChrome);

      pCtx.connected = true;
      pCtx.debuggerAttached = true;
      pCtx.currentDebuggerTabId = 42;
      pCtx.attachedTabId = 7;

      // Allow fire-and-forget persist to complete
      await new Promise(r => setTimeout(r, 10));

      expect(mockChrome.storage.session.set).toHaveBeenCalled();
      const stored = mockChrome._store['__supersurf_session_state'];
      expect(stored).toBeDefined();
      expect(stored.connected).toBe(true);
      expect(stored.debuggerAttached).toBe(true);
      expect(stored.currentDebuggerTabId).toBe(42);
      expect(stored.sessions['__null__'].attachedTabId).toBe(7);
    });

    it('rehydrates state from chrome.storage.session', async () => {
      const mockChrome = createMockChrome();
      mockChrome._store['__supersurf_session_state'] = {
        connected: true,
        debuggerAttached: true,
        currentDebuggerTabId: 55,
        sessions: {
          '__null__': {
            attachedTabId: 12,
            stealthMode: true,
            stealthTabs: [[12, true]],
            cursorPositions: [[12, { x: 100, y: 200 }]],
            humanizationConfig: { enabled: true },
          },
        },
      };

      const pCtx = new SessionContext();
      await pCtx.init(mockChrome);

      expect(pCtx.connected).toBe(true);
      expect(pCtx.debuggerAttached).toBe(true);
      expect(pCtx.currentDebuggerTabId).toBe(55);
      expect(pCtx.attachedTabId).toBe(12);
      expect(pCtx.stealthMode).toBe(true);
      expect(pCtx.stealthTabs.get(12)).toBe(true);
      expect(pCtx.cursorPositions.get(12)).toEqual({ x: 100, y: 200 });
      expect(pCtx.humanizationConfig.enabled).toBe(true);
    });

    it('clearStorage removes persisted state', async () => {
      const mockChrome = createMockChrome();
      const pCtx = new SessionContext();
      await pCtx.init(mockChrome);

      pCtx.connected = true;
      await new Promise(r => setTimeout(r, 10));

      await pCtx.clearStorage();
      expect(mockChrome.storage.session.remove).toHaveBeenCalledWith('__supersurf_session_state');
    });

    it('works without chrome.storage.session (test/offline mode)', () => {
      const pCtx = new SessionContext();
      // No init() call — should work fine without persistence
      pCtx.connected = true;
      pCtx.attachedTabId = 5;
      expect(pCtx.connected).toBe(true);
      expect(pCtx.attachedTabId).toBe(5);
    });

    it('persistSession() triggers write-through for Map mutations', async () => {
      const mockChrome = createMockChrome();
      const pCtx = new SessionContext();
      await pCtx.init(mockChrome);

      pCtx.cursorPositions.set(1, { x: 50, y: 75 });
      pCtx.persistSession();

      await new Promise(r => setTimeout(r, 10));

      const stored = mockChrome._store['__supersurf_session_state'];
      const session = stored.sessions['__null__'];
      expect(session.cursorPositions).toEqual([[1, { x: 50, y: 75 }]]);
    });
  });
});
