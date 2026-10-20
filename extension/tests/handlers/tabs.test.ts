import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockChrome } from '../__mocks__/chrome';
import { TabHandlers } from '../../src/handlers/tabs';
import { SessionContext } from '../../src/session-context';

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

describe('TabHandlers', () => {
  let mockChrome: ReturnType<typeof createMockChrome>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockIconManager: ReturnType<typeof createMockIconManager>;
  let sessionContext: SessionContext;
  let tabs: TabHandlers;

  beforeEach(() => {
    mockChrome = createMockChrome();
    mockLogger = createMockLogger();
    mockIconManager = createMockIconManager();
    sessionContext = new SessionContext();
    tabs = new TabHandlers(mockChrome, mockLogger, mockIconManager, sessionContext);
  });

  describe('getAttachedTabId()', () => {
    it('returns null initially', () => {
      expect(tabs.getAttachedTabId(null)).toBeNull();
    });
  });

  describe('createTab()', () => {
    it('creates a tab and attaches it', async () => {
      const createdTab = { id: 100, index: 0, title: 'New Tab', url: 'https://example.com' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);

      const result = await tabs.createTab({ url: 'https://example.com' });

      expect(mockChrome.tabs.create).toHaveBeenCalledWith({
        url: 'https://example.com',
        active: true,
      });
      expect(tabs.getAttachedTabId(null)).toBe(100);
      expect(result.attachedTab.id).toBe(100);
    });

    it('defaults to about:blank when no url is provided', async () => {
      const createdTab = { id: 101, index: 0, title: 'New Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);

      await tabs.createTab({});

      expect(mockChrome.tabs.create).toHaveBeenCalledWith({
        url: 'about:blank',
        active: true,
      });
    });

    it('passes activate=false correctly', async () => {
      const createdTab = { id: 102, index: 0, title: 'New Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);

      await tabs.createTab({ activate: false });

      expect(mockChrome.tabs.create).toHaveBeenCalledWith({
        url: 'about:blank',
        active: false,
      });
    });

    it('calls iconManager.setAttachedTab with the new tab id', async () => {
      const createdTab = { id: 103, index: 0, title: 'New Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);

      await tabs.createTab({});

      expect(mockIconManager.setAttachedTab).toHaveBeenCalledWith(103);
    });

    it('calls iconManager.setStealthMode', async () => {
      const createdTab = { id: 104, index: 0, title: 'New Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);

      await tabs.createTab({ stealth: true });

      expect(mockIconManager.setStealthMode).toHaveBeenCalledWith(true);
      expect((await tabs.createTab({ stealth: true })).stealthMode).toBe(true);
    });

    it('calls console and dialog injectors when set', async () => {
      const createdTab = { id: 105, index: 0, title: 'New Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);

      const consoleInjector = vi.fn().mockResolvedValue(undefined);
      const dialogInjector = vi.fn().mockResolvedValue(undefined);

      tabs.setConsoleInjector(consoleInjector);
      tabs.setDialogInjector(dialogInjector);

      await tabs.createTab({});

      expect(consoleInjector).toHaveBeenCalledWith(105);
      expect(dialogInjector).toHaveBeenCalledWith(105);
    });

    it('handles injector failures gracefully', async () => {
      const createdTab = { id: 106, index: 0, title: 'New Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);

      const failingInjector = vi.fn().mockRejectedValue(new Error('inject fail'));
      tabs.setConsoleInjector(failingInjector);

      // Should not throw
      const result = await tabs.createTab({});
      expect(result.attachedTab.id).toBe(106);
    });

    it('returns correct result shape', async () => {
      const createdTab = { id: 200, index: 3, title: 'My Page', url: 'https://test.com' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);

      const result = await tabs.createTab({ url: 'https://test.com', stealth: true });

      expect(result).toEqual({
        attachedTab: {
          id: 200,
          index: 3,
          title: 'My Page',
          url: 'https://test.com',
          groupId: -1,
        },
        stealthMode: true,
      });
    });
  });

  describe('selectTab()', () => {
    it('attaches to an existing tab by index', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, index: 0, title: 'Tab 0', url: 'https://a.com' },
        { id: 20, index: 1, title: 'Tab 1', url: 'https://b.com' },
      ]);

      const result = await tabs.selectTab({ index: 1 });

      expect(tabs.getAttachedTabId(null)).toBe(20);
      expect(result.attachedTab.id).toBe(20);
      expect(result.attachedTab.index).toBe(1);
    });

    it('rejects chrome:// URLs', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Settings', url: 'chrome://settings' },
      ]);

      await expect(tabs.selectTab({ index: 0 })).rejects.toThrow(
        'Cannot automate chrome://settings'
      );
    });

    it('rejects chrome-extension:// URLs', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Extension', url: 'chrome-extension://abc/popup.html' },
      ]);

      await expect(tabs.selectTab({ index: 0 })).rejects.toThrow('Cannot automate');
    });

    it('throws for out-of-range index (too high)', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Tab 0', url: 'https://a.com' },
      ]);

      await expect(tabs.selectTab({ index: 5 })).rejects.toThrow('out of range');
    });

    it('throws for negative index', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Tab 0', url: 'https://a.com' },
      ]);

      await expect(tabs.selectTab({ index: -1 })).rejects.toThrow('out of range');
    });

    it('activates the tab when activate=true', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Tab 0', url: 'https://a.com' },
      ]);

      await tabs.selectTab({ index: 0, activate: true });

      expect(mockChrome.tabs.update).toHaveBeenCalledWith(10, { active: true });
    });

    it('activates the tab by default when activate is not set', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, index: 0, title: 'Tab 0', url: 'https://a.com' },
      ]);

      await tabs.selectTab({ index: 0 });

      // Default behavior: activate !== false, so tab is activated
      expect(mockChrome.tabs.update).toHaveBeenCalledWith(10, { active: true });
    });

    it('calls console/dialog injectors', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Tab 0', url: 'https://a.com' },
      ]);

      const consoleInjector = vi.fn().mockResolvedValue(undefined);
      const dialogInjector = vi.fn().mockResolvedValue(undefined);
      tabs.setConsoleInjector(consoleInjector);
      tabs.setDialogInjector(dialogInjector);

      await tabs.selectTab({ index: 0 });

      expect(consoleInjector).toHaveBeenCalledWith(10);
      expect(dialogInjector).toHaveBeenCalledWith(10);
    });

    it('includes techStack in result when available', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Tab 0', url: 'https://a.com' },
      ]);

      tabs.setTechStackInfo(10, { react: true });

      const result = await tabs.selectTab({ index: 0 });
      expect(result.attachedTab.techStack).toEqual({ react: true });
    });
  });

  describe('closeTab()', () => {
    it('closes the currently attached tab when no index specified', async () => {
      // First attach a tab
      const createdTab = { id: 50, index: 0, title: 'Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);
      await tabs.createTab({});

      expect(tabs.getAttachedTabId(null)).toBe(50);

      const result = await tabs.closeTab();

      expect(mockChrome.tabs.remove).toHaveBeenCalledWith(50);
      expect(result.success).toBe(true);
      expect(tabs.getAttachedTabId(null)).toBeNull();
    });

    it('closes a specific tab by index', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Tab 0', url: 'https://a.com' },
        { id: 20, title: 'Tab 1', url: 'https://b.com' },
      ]);

      const result = await tabs.closeTab({ index: 1 });

      expect(mockChrome.tabs.remove).toHaveBeenCalledWith(20);
      expect(result.success).toBe(true);
    });

    it('throws when no tab specified and none attached', async () => {
      mockChrome.tabs.query.mockResolvedValue([]);
      await expect(tabs.closeTab()).rejects.toThrow('No tab specified and no tab attached');
    });

    it('includes available tab count in error message', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Tab 0', url: 'https://a.com' },
        { id: 20, title: 'Tab 1', url: 'https://b.com' },
      ]);

      await expect(tabs.closeTab()).rejects.toThrow(/2 tabs available/);
    });

    it('throws for out-of-range index', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 10, title: 'Tab 0', url: 'https://a.com' },
      ]);

      await expect(tabs.closeTab({ index: 5 })).rejects.toThrow('out of range');
    });

    it('clears attached tab if the closed tab was attached and no others exist', async () => {
      const createdTab = { id: 60, index: 0, title: 'Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);
      await tabs.createTab({});

      // First query for closeTab's index lookup, then empty for auto-reattach
      mockChrome.tabs.query
        .mockResolvedValueOnce([{ id: 60, title: 'Tab', url: 'about:blank' }])
        .mockResolvedValueOnce([]);

      await tabs.closeTab({ index: 0 });

      // Wait for async auto-reattach to resolve (finds no candidates)
      await new Promise(r => setTimeout(r, 10));

      expect(tabs.getAttachedTabId(null)).toBeNull();
      expect(mockIconManager.setAttachedTab).toHaveBeenCalledWith(null);
    });
  });

  describe('handleTabClosed()', () => {
    it('clears attached tab when the closed tab matches', async () => {
      const createdTab = { id: 70, index: 0, title: 'Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);
      await tabs.createTab({});

      expect(tabs.getAttachedTabId(null)).toBe(70);

      tabs.handleTabClosed(70);

      expect(tabs.getAttachedTabId(null)).toBeNull();
      expect(mockIconManager.setAttachedTab).toHaveBeenCalledWith(null);
    });

    it('does not clear attached tab when a different tab is closed', async () => {
      const createdTab = { id: 80, index: 0, title: 'Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);
      await tabs.createTab({});

      mockIconManager.setAttachedTab.mockClear();

      tabs.handleTabClosed(999);

      expect(tabs.getAttachedTabId(null)).toBe(80);
      expect(mockIconManager.setAttachedTab).not.toHaveBeenCalled();
    });

    it('cleans up stealth and techStack maps', async () => {
      const createdTab = { id: 90, index: 0, title: 'Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);
      await tabs.createTab({ stealth: true });

      tabs.setTechStackInfo(90, { vue: true });

      tabs.handleTabClosed(90);

      // After cleanup, selecting a tab with same id should not have old techStack
      // We verify indirectly through getTabs
      mockChrome.tabs.query.mockResolvedValue([
        { id: 90, title: 'New Tab', url: 'https://example.com' },
      ]);

      const result = await tabs.getTabs();
      expect(result.tabs[0].stealthMode).toBeNull();
      expect(result.tabs[0].techStack).toBeNull();
    });

    it('is called automatically via onRemoved listener', async () => {
      const createdTab = { id: 95, index: 0, title: 'Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);
      await tabs.createTab({});

      expect(tabs.getAttachedTabId(null)).toBe(95);

      // Fire the onRemoved event
      mockChrome.tabs.onRemoved._fire(95, { windowId: 1, isWindowClosing: false });

      expect(tabs.getAttachedTabId(null)).toBeNull();
    });

    it('auto-reattaches to another owned tab when attached tab is closed externally', async () => {
      mockChrome.tabGroups.query.mockResolvedValue([
        { id: 5, title: 'rec', color: 'blue', collapsed: false, windowId: 1 },
      ]);
      sessionContext.getSession('rec').attachedTabId = 50;
      const tab2 = { id: 60, index: 1, title: 'Tab 2', url: 'https://b.com', windowId: 1, active: true, groupId: 5 };

      // Simulate tab 50 closing externally — query returns remaining tabs
      mockChrome.tabs.query.mockResolvedValue([tab2]);

      tabs.handleTabClosed(50);
      await new Promise(r => setTimeout(r, 10));

      expect(tabs.getAttachedTabId('rec')).toBe(60);
    });

    it('sets attachedTabId to null when no other tabs available after close', async () => {
      const tab1 = { id: 50, index: 0, title: 'Tab 1', url: 'https://a.com', windowId: 1 };
      mockChrome.tabs.create.mockResolvedValue(tab1);
      await tabs.createTab({ url: 'https://a.com' });

      // No other tabs available
      mockChrome.tabs.query.mockResolvedValue([]);

      tabs.handleTabClosed(50);
      await new Promise(r => setTimeout(r, 10));

      expect(tabs.getAttachedTabId(null)).toBeNull();
    });
  });

  describe('owned-tabs-only reattach and recovery', () => {
    const groups = [
      { id: 1, title: 'agent-a', color: 'blue', collapsed: false, windowId: 1 },
      { id: 2, title: 'agent-b', color: 'red', collapsed: false, windowId: 1 },
    ];
    const tabA = { id: 10, url: 'https://a.com', windowId: 1, active: true, groupId: 1 };
    const tabB2 = { id: 21, url: 'https://b2.com', windowId: 1, active: false, groupId: 2 };
    const flush = () => new Promise((r) => setTimeout(r, 10));
    const NO_TAB = /No tab is attached to this session/;

    beforeEach(() => {
      mockChrome.tabGroups.query.mockImplementation(async (q: any) =>
        groups.filter((g) => q?.title === undefined || g.title === q.title));
    });

    it('autoReattach never takes another session\'s tab', async () => {
      sessionContext.getSession('agent-b').attachedTabId = 20;
      mockChrome.tabs.query.mockResolvedValue([tabA]);
      tabs.handleTabClosed(20);
      await flush();
      expect(tabs.getAttachedTabId('agent-b')).toBeNull();
    });

    it('autoReattach moves to another tab the session owns', async () => {
      sessionContext.getSession('agent-b').attachedTabId = 20;
      mockChrome.tabs.query.mockResolvedValue([tabA, tabB2]);
      tabs.handleTabClosed(20);
      await flush();
      expect(tabs.getAttachedTabId('agent-b')).toBe(21);
    });

    it('ensureAttachedTab refuses to recover onto another session\'s tab', async () => {
      mockChrome.tabs.query.mockResolvedValue([tabA]);
      await expect(tabs.ensureAttachedTab('agent-b')).rejects.toThrow(NO_TAB);
      expect(tabs.getAttachedTabId('agent-b')).toBeNull();
    });

    it('ensureAttachedTab recovers a stale attachment to an owned tab', async () => {
      sessionContext.getSession('agent-b').attachedTabId = 999;
      mockChrome.tabs.get.mockRejectedValue(new Error('No tab'));
      mockChrome.tabs.query.mockResolvedValue([tabA, tabB2]);
      const result = await tabs.ensureAttachedTab('agent-b');
      expect(result.tabId).toBe(21);
      expect(result.recovery!.reason).toBe('stale-attached-tab');
    });

    it('a nameless session owns nothing and cannot recover', async () => {
      mockChrome.tabs.query.mockResolvedValue([tabA]);
      await expect(tabs.ensureAttachedTab(null)).rejects.toThrow(NO_TAB);
    });
  });

  describe('getTabs()', () => {
    it('returns formatted tab list with attached status', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 1, index: 0, title: 'Google', url: 'https://google.com' },
        { id: 2, index: 1, title: 'GitHub', url: 'https://github.com' },
      ]);

      const result = await tabs.getTabs();

      expect(result.tabs).toHaveLength(2);
      expect(result.tabs[0]).toEqual({
        id: 1,
        index: 0,
        title: 'Google',
        url: 'https://google.com',
        automatable: true,
        attached: false,
        groupId: -1,
        stealthMode: null,
        windowType: 'normal',
        techStack: null,
      });
      expect(result.attachedTabId).toBeNull();
    });

    it('marks chrome:// tabs as not automatable', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 1, title: 'Settings', url: 'chrome://settings' },
      ]);

      const result = await tabs.getTabs();
      expect(result.tabs[0].automatable).toBe(false);
    });

    it('marks chrome-extension:// tabs as not automatable', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 1, title: 'Extension', url: 'chrome-extension://abc/popup.html' },
      ]);

      const result = await tabs.getTabs();
      expect(result.tabs[0].automatable).toBe(false);
    });

    it('marks about: tabs as not automatable', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 1, title: 'About', url: 'about:blank' },
      ]);

      const result = await tabs.getTabs();
      expect(result.tabs[0].automatable).toBe(false);
    });

    it('marks the attached tab correctly', async () => {
      const createdTab = { id: 5, index: 0, title: 'Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);
      await tabs.createTab({});

      mockChrome.tabs.query.mockResolvedValue([
        { id: 5, title: 'Tab', url: 'https://example.com' },
        { id: 6, title: 'Other', url: 'https://other.com' },
      ]);

      const result = await tabs.getTabs();
      expect(result.tabs[0].attached).toBe(true);
      expect(result.tabs[1].attached).toBe(false);
      expect(result.attachedTabId).toBe(5);
    });

    it('handles tabs with no title', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 1, url: 'https://example.com' },
      ]);

      const result = await tabs.getTabs();
      expect(result.tabs[0].title).toBe('Untitled');
    });

    it('handles tabs with no url', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 1, title: 'Tab' },
      ]);

      const result = await tabs.getTabs();
      expect(result.tabs[0].url).toBe('');
      // Empty URL is not chrome:// or about:, so it's technically automatable
      expect(result.tabs[0].automatable).toBe(true);
    });
  });

  describe('ensureAttachedTab() — recovery', () => {
    it('returns the current attached tab without recovery when it is valid', async () => {
      const created = { id: 300, index: 0, title: 'Tab', url: 'about:blank', windowId: 1 };
      mockChrome.tabs.create.mockResolvedValue(created);
      await tabs.createTab({});

      // chrome.tabs.get will succeed (mock default)
      mockChrome.tabs.get.mockResolvedValue({
        id: 300, index: 0, title: 'Tab', url: 'https://example.com', windowId: 1,
      });

      const result = await tabs.ensureAttachedTab(null);
      expect(result.tabId).toBe(300);
      expect(result.recovery).toBeUndefined();
    });

    it('honors an explicit tabId and returns it without recovery', async () => {
      sessionContext.getSession().attachedTabId = 10;
      mockChrome.tabs.get.mockResolvedValue({ id: 20, index: 1, title: 'B', url: 'https://b.com', windowId: 1 });

      const result = await tabs.ensureAttachedTab(null, 20);
      expect(result.tabId).toBe(20);
      expect(result.recovery).toBeUndefined();
    });

    it('does NOT mutate the shared attachedTabId when given an explicit tabId (concurrency isolation)', async () => {
      // The shared global points at tab 10; an explicit override to tab 20 must
      // not flip it — otherwise one caller would redirect a concurrent caller.
      sessionContext.getSession().attachedTabId = 10;
      mockChrome.tabs.get.mockResolvedValue({ id: 20, index: 1, title: 'B', url: 'https://b.com', windowId: 1 });

      await tabs.ensureAttachedTab(null, 20);
      expect(tabs.getAttachedTabId(null)).toBe(10);
    });

    it('throws for an explicit tabId that no longer exists (without touching the global)', async () => {
      sessionContext.getSession().attachedTabId = 10;
      mockChrome.tabs.get.mockRejectedValue(new Error('No tab with id: 999'));

      await expect(tabs.ensureAttachedTab(null, 999)).rejects.toThrow();
      expect(tabs.getAttachedTabId(null)).toBe(10);
    });

    // Recovery is owned-tabs-only: tests use session 'rec' whose group (id 5) holds the tabs.
    describe('owned-tab recovery', () => {
      beforeEach(() => {
        mockChrome.tabGroups.query.mockResolvedValue([
          { id: 5, title: 'rec', color: 'blue', collapsed: false, windowId: 1 },
        ]);
      });
      const own = (t: any) => ({ groupId: 5, ...t });

      it('recovers when attachedTabId is null by selecting the active visible tab', async () => {
        mockChrome.tabs.query.mockResolvedValue([
          own({ id: 1, index: 0, title: 'A', url: 'https://a.com', windowId: 1, active: false }),
          own({ id: 2, index: 1, title: 'B', url: 'https://b.com', windowId: 1, active: true }),
        ]);

        const result = await tabs.ensureAttachedTab('rec');
        expect(result.tabId).toBe(2);
        expect(result.recovery!.reason).toBe('no-attached-tab');
        expect(result.recovery!.newTabId).toBe(2);
        expect(result.recovery!.url).toBe('https://b.com');
        expect(tabs.getAttachedTabId('rec')).toBe(2);
      });

      it('recovers when attachedTabId points at a tab that no longer exists (stale)', async () => {
        sessionContext.getSession('rec').attachedTabId = 999;
        mockChrome.tabs.get.mockImplementation(async (id: number) => {
          if (id === 999) throw new Error('No tab with id 999');
          return { id, index: 0, title: 'T', url: 'https://x.com', windowId: 1 };
        });
        mockChrome.tabs.query.mockResolvedValue([
          own({ id: 11, index: 0, title: 'A', url: 'https://a.com', windowId: 1, active: true }),
        ]);

        const result = await tabs.ensureAttachedTab('rec');
        expect(result.tabId).toBe(11);
        expect(result.recovery!.reason).toBe('stale-attached-tab');
        expect(result.recovery!.previousTabId).toBe(999);
        expect(result.recovery!.newTabId).toBe(11);
        expect(tabs.getAttachedTabId('rec')).toBe(11);
      });

      it('prefers the active owned tab in the current window', async () => {
        sessionContext.getSession('rec').attachedTabId = 777;
        mockChrome.tabs.get.mockRejectedValue(new Error('No tab'));
        mockChrome.tabs.query.mockResolvedValue([
          own({ id: 40, index: 0, title: 'other-win active', url: 'https://o.com', windowId: 2, active: true }),
          own({ id: 50, index: 0, title: 'same-win inactive', url: 'https://s.com', windowId: 1, active: false }),
          own({ id: 60, index: 1, title: 'same-win active', url: 'https://s2.com', windowId: 1, active: true }),
        ]);
        mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: 'normal', focused: true });

        const result = await tabs.ensureAttachedTab('rec');
        expect(result.tabId).toBe(60);
      });

      it('falls back to any owned automatable tab when no active one matches', async () => {
        mockChrome.tabs.query.mockResolvedValue([
          own({ id: 70, index: 0, title: 'A', url: 'https://a.com', windowId: 1, active: false }),
        ]);

        const result = await tabs.ensureAttachedTab('rec');
        expect(result.tabId).toBe(70);
        expect(result.recovery).toBeDefined();
      });

      it('skips chrome://, chrome-extension:// and about: tabs when recovering', async () => {
        mockChrome.tabs.query.mockResolvedValue([
          own({ id: 80, index: 0, title: 'settings', url: 'chrome://settings', windowId: 1, active: true }),
          own({ id: 81, index: 1, title: 'ext', url: 'chrome-extension://abc/', windowId: 1, active: false }),
          own({ id: 83, index: 3, title: 'blank', url: 'about:blank', windowId: 1, active: false }),
          own({ id: 82, index: 2, title: 'real', url: 'https://real.com', windowId: 1, active: false }),
        ]);

        const result = await tabs.ensureAttachedTab('rec');
        expect(result.tabId).toBe(82);
      });

      it('throws the no-tab-attached error when the session owns no tabs', async () => {
        mockChrome.tabs.query.mockResolvedValue([]);
        await expect(tabs.ensureAttachedTab('rec')).rejects.toThrow(/No tab is attached to this session/);
      });

      it('throws the no-tab-attached error when only non-automatable owned tabs exist', async () => {
        mockChrome.tabs.query.mockResolvedValue([
          own({ id: 90, index: 0, title: 'x', url: 'chrome://settings', windowId: 1, active: true }),
        ]);
        await expect(tabs.ensureAttachedTab('rec')).rejects.toThrow(/No tab is attached to this session/);
      });

      it('logs recovery via logger so audit can pick it up', async () => {
        mockChrome.tabs.query.mockResolvedValue([
          own({ id: 100, index: 0, title: 'A', url: 'https://a.com', windowId: 1, active: true }),
        ]);

        await tabs.ensureAttachedTab('rec');
        const logCalls = (mockLogger.log as any).mock.calls.map((c: any[]) => String(c[0]));
        expect(logCalls.some((m: string) => /recover/i.test(m))).toBe(true);
      });

      it('updates the icon manager on recovery', async () => {
        mockChrome.tabs.query.mockResolvedValue([
          own({ id: 110, index: 0, title: 'A', url: 'https://a.com', windowId: 1, active: true }),
        ]);

        await tabs.ensureAttachedTab('rec');
        expect(mockIconManager.setAttachedTab).toHaveBeenCalledWith(110);
      });
    });
  });

  describe('setTechStackInfo()', () => {
    it('stores tech stack info for a tab', async () => {
      tabs.setTechStackInfo(42, { react: '18.2', nextjs: true });

      mockChrome.tabs.query.mockResolvedValue([
        { id: 42, title: 'React App', url: 'https://app.com' },
      ]);

      const result = await tabs.getTabs();
      expect(result.tabs[0].techStack).toEqual({ react: '18.2', nextjs: true });
    });
  });

  describe('session tab groups (client_id persist)', () => {
    it('disconnect closes created tabs, ungroups the rest and drops session state', async () => {
      sessionContext.getSession('proj-abc12');
      mockChrome.tabGroups.query.mockResolvedValue([
        { id: 42, title: 'proj-abc12', color: 'blue', collapsed: false, windowId: 1 },
      ]);
      mockChrome.tabs.query.mockResolvedValue([
        { id: 100, groupId: 42, windowId: 1 }, // created
        { id: 200, groupId: 42, windowId: 1 }, // attached
      ]);

      await tabs.handleSessionDisconnect('proj-abc12', [100]);

      expect(mockChrome.tabs.remove).toHaveBeenCalledWith(100);
      expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith([200]);
      expect(sessionContext.sessionEntries().map(([id]) => id)).not.toContain('proj-abc12');
    });

    it('a created tab that is already gone does not stop teardown', async () => {
      mockChrome.tabs.remove.mockRejectedValueOnce(new Error('No tab with id: 100'));
      mockChrome.tabGroups.query.mockResolvedValue([
        { id: 42, title: 'p', color: 'blue', collapsed: false, windowId: 1 },
      ]);
      mockChrome.tabs.query.mockResolvedValue([{ id: 200, groupId: 42, windowId: 1 }]);

      await expect(tabs.handleSessionDisconnect('p', [100])).resolves.toMatchObject({ success: true });
      expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith([200]);
    });

    it('with no tab group, still closes created tabs and drops session state', async () => {
      sessionContext.getSession('nogroup');
      mockChrome.tabGroups.query.mockResolvedValue([]);

      await tabs.handleSessionDisconnect('nogroup', [100]);

      expect(mockChrome.tabs.remove).toHaveBeenCalledWith(100);
      expect(sessionContext.sessionEntries().map(([id]) => id)).not.toContain('nogroup');
    });

    it('reclaim by title restores stored color after cold cache', async () => {
      // Simulate SW restart: new TabHandlers instance, storage still has color
      mockChrome.storage._data['supersurf.sessionGroupColors'] = { 'proj-abc12': 'red' };
      mockChrome.tabGroups.query.mockResolvedValue([
        { id: 77, title: 'proj-abc12', color: 'grey', collapsed: false, windowId: 1 },
      ]);
      mockChrome.tabs.create.mockResolvedValue({
        id: 200, index: 0, title: 't', url: 'https://example.com', groupId: -1, windowId: 1,
      });
      mockChrome.tabs.group.mockResolvedValue(77);

      const fresh = new TabHandlers(mockChrome, mockLogger, mockIconManager, new SessionContext());
      await fresh.createTab({ url: 'https://example.com', _sessionId: 'proj-abc12' });

      expect(mockChrome.tabGroups.query).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'proj-abc12' }),
      );
      expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(
        77,
        expect.objectContaining({ color: 'red' }),
      );
      expect(mockChrome.tabs.group).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: 77, tabIds: [200] }),
      );
    });
  });
});
