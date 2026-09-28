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

    it('defaults to no attached debugger tabs', () => {
      expect(ctx.isDebuggerAttached(42)).toBe(false);
      expect(ctx.attachedDebuggerTabs()).toEqual([]);
    });

    it('allows setting global state', () => {
      ctx.connected = true;
      ctx.markDebuggerAttached(42);

      expect(ctx.connected).toBe(true);
      expect(ctx.isDebuggerAttached(42)).toBe(true);
      expect(ctx.attachedDebuggerTabs()).toEqual([42]);
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

  describe('persistence', () => {
    it('persists state to chrome.storage.session on mutation', async () => {
      const mockChrome = createMockChrome();
      const pCtx = new SessionContext();
      await pCtx.init(mockChrome);

      pCtx.connected = true;
      pCtx.markDebuggerAttached(42);
      pCtx.getSession().attachedTabId = 7;
      pCtx.persistSession();

      // Allow fire-and-forget persist to complete
      await new Promise(r => setTimeout(r, 10));

      expect(mockChrome.storage.session.set).toHaveBeenCalled();
      const stored = mockChrome._store['__supersurf_session_state'];
      expect(stored).toBeDefined();
      expect(stored.connected).toBe(true);
      expect(stored.attachedDebuggerTabs).toEqual([42]);
      expect(stored.sessions['__null__'].attachedTabId).toBe(7);
    });

    it('rehydrates connected state but NOT debugger attachments (a restart drops real CDP attachments)', async () => {
      const mockChrome = createMockChrome();
      mockChrome._store['__supersurf_session_state'] = {
        connected: true,
        attachedDebuggerTabs: [55],
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
      expect(pCtx.isDebuggerAttached(55)).toBe(false);
      expect(pCtx.attachedDebuggerTabs()).toEqual([]);
      const session = pCtx.getSession();
      expect(session.attachedTabId).toBe(12);
      expect(session.stealthMode).toBe(true);
      expect(session.stealthTabs.get(12)).toBe(true);
      expect(session.cursorPositions.get(12)).toEqual({ x: 100, y: 200 });
      expect(session.humanizationConfig.enabled).toBe(true);
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
      pCtx.getSession().attachedTabId = 5;
      expect(pCtx.connected).toBe(true);
      expect(pCtx.getSession().attachedTabId).toBe(5);
    });

    it('persistSession() triggers write-through for Map mutations', async () => {
      const mockChrome = createMockChrome();
      const pCtx = new SessionContext();
      await pCtx.init(mockChrome);

      pCtx.getSession().cursorPositions.set(1, { x: 50, y: 75 });
      pCtx.persistSession();

      await new Promise(r => setTimeout(r, 10));

      const stored = mockChrome._store['__supersurf_session_state'];
      const session = stored.sessions['__null__'];
      expect(session.cursorPositions).toEqual([[1, { x: 50, y: 75 }]]);
    });
  });
});

describe('SessionContext.dialogPending', () => {
  it('defaults to false', () => {
    expect(new SessionContext().dialogPending).toBe(false);
  });

  it('is settable and gettable', () => {
    const ctx = new SessionContext();
    ctx.dialogPending = true;
    expect(ctx.dialogPending).toBe(true);
    ctx.dialogPending = false;
    expect(ctx.dialogPending).toBe(false);
  });

  it('is NOT included in persisted serialized state', async () => {
    const store: Record<string, any> = {};
    const chromeRef: any = {
      storage: { session: {
        get: vi.fn(async (k: string) => ({ [k]: store[k] })),
        set: vi.fn(async (obj: any) => { Object.assign(store, obj); }),
        remove: vi.fn(async () => {}),
      } },
    };
    const ctx = new SessionContext();
    await ctx.init(chromeRef);
    ctx.dialogPending = true;        // must NOT persist
    ctx.connected = true;            // DOES persist — forces a write-through
    const persisted = store['__supersurf_session_state'];
    expect(persisted).toBeDefined();
    expect('dialogPending' in persisted).toBe(false);
  });
});
