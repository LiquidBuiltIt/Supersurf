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
      expect(tabs.getAttachedTabId()).toBeNull();
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
      expect(tabs.getAttachedTabId()).toBe(100);
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

      expect(tabs.getAttachedTabId()).toBe(20);
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

      expect(tabs.getAttachedTabId()).toBe(50);

      const result = await tabs.closeTab();

      expect(mockChrome.tabs.remove).toHaveBeenCalledWith(50);
      expect(result.success).toBe(true);
      expect(tabs.getAttachedTabId()).toBeNull();
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

      expect(tabs.getAttachedTabId()).toBeNull();
      expect(mockIconManager.setAttachedTab).toHaveBeenCalledWith(null);
    });
  });

  describe('handleTabClosed()', () => {
    it('clears attached tab when the closed tab matches', async () => {
      const createdTab = { id: 70, index: 0, title: 'Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);
      await tabs.createTab({});

      expect(tabs.getAttachedTabId()).toBe(70);

      tabs.handleTabClosed(70);

      expect(tabs.getAttachedTabId()).toBeNull();
      expect(mockIconManager.setAttachedTab).toHaveBeenCalledWith(null);
    });

    it('does not clear attached tab when a different tab is closed', async () => {
      const createdTab = { id: 80, index: 0, title: 'Tab', url: 'about:blank' };
      mockChrome.tabs.create.mockResolvedValue(createdTab);
      await tabs.createTab({});

      tabs.handleTabClosed(999);

      expect(tabs.getAttachedTabId()).toBe(80);
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

      expect(tabs.getAttachedTabId()).toBe(95);

      // Fire the onRemoved event
      mockChrome.tabs.onRemoved._fire(95, { windowId: 1, isWindowClosing: false });

      expect(tabs.getAttachedTabId()).toBeNull();
    });

    it('auto-reattaches to another tab when attached tab is closed externally', async () => {
      const tab1 = { id: 50, index: 0, title: 'Tab 1', url: 'https://a.com', windowId: 1 };
      const tab2 = { id: 60, index: 1, title: 'Tab 2', url: 'https://b.com', windowId: 1, active: true };
      mockChrome.tabs.create.mockResolvedValue(tab1);
      await tabs.createTab({ url: 'https://a.com' });

      // Attach to tab1
      mockChrome.tabs.query.mockResolvedValue([tab1, tab2]);
      await tabs.selectTab({ index: 0 });
      expect(tabs.getAttachedTabId()).toBe(50);

      // Simulate tab1 closing externally — query returns remaining tabs
      mockChrome.tabs.query.mockResolvedValue([tab2]);

      tabs.handleTabClosed(50);

      // Wait for async auto-reattach
      await new Promise(r => setTimeout(r, 10));

      expect(tabs.getAttachedTabId()).toBe(60);
    });

    it('sets attachedTabId to null when no other tabs available after close', async () => {
      const tab1 = { id: 50, index: 0, title: 'Tab 1', url: 'https://a.com', windowId: 1 };
      mockChrome.tabs.create.mockResolvedValue(tab1);
      await tabs.createTab({ url: 'https://a.com' });

      // No other tabs available
      mockChrome.tabs.query.mockResolvedValue([]);

      tabs.handleTabClosed(50);
      await new Promise(r => setTimeout(r, 10));

      expect(tabs.getAttachedTabId()).toBeNull();
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

      const result = await tabs.ensureAttachedTab();
      expect(result.tabId).toBe(300);
      expect(result.recovery).toBeUndefined();
    });

    it('honors an explicit tabId and returns it without recovery', async () => {
      sessionContext.attachedTabId = 10;
      mockChrome.tabs.get.mockResolvedValue({ id: 20, index: 1, title: 'B', url: 'https://b.com', windowId: 1 });

      const result = await tabs.ensureAttachedTab(20);
      expect(result.tabId).toBe(20);
      expect(result.recovery).toBeUndefined();
    });

    it('does NOT mutate the shared attachedTabId when given an explicit tabId (concurrency isolation)', async () => {
      // The shared global points at tab 10; an explicit override to tab 20 must
      // not flip it — otherwise one caller would redirect a concurrent caller.
      sessionContext.attachedTabId = 10;
      mockChrome.tabs.get.mockResolvedValue({ id: 20, index: 1, title: 'B', url: 'https://b.com', windowId: 1 });

      await tabs.ensureAttachedTab(20);
      expect(tabs.getAttachedTabId()).toBe(10);
    });

    it('throws for an explicit tabId that no longer exists (without touching the global)', async () => {
      sessionContext.attachedTabId = 10;
      mockChrome.tabs.get.mockRejectedValue(new Error('No tab with id: 999'));

      await expect(tabs.ensureAttachedTab(999)).rejects.toThrow();
      expect(tabs.getAttachedTabId()).toBe(10);
    });

    it('recovers when attachedTabId is null by selecting the active visible tab', async () => {
      // No attached tab
      expect(tabs.getAttachedTabId()).toBeNull();

      mockChrome.tabs.query.mockResolvedValue([
        { id: 1, index: 0, title: 'A', url: 'https://a.com', windowId: 1, active: false },
        { id: 2, index: 1, title: 'B', url: 'https://b.com', windowId: 1, active: true },
      ]);

      const result = await tabs.ensureAttachedTab();
      expect(result.tabId).toBe(2);
      expect(result.recovery).toBeDefined();
      expect(result.recovery!.reason).toBe('no-attached-tab');
      expect(result.recovery!.newTabId).toBe(2);
      expect(result.recovery!.url).toBe('https://b.com');
      expect(tabs.getAttachedTabId()).toBe(2);
    });

    it('recovers when attachedTabId points at a tab that no longer exists (stale)', async () => {
      // Force-set a stale attached tab id
      sessionContext.attachedTabId = 999;

      // chrome.tabs.get throws for 999
      mockChrome.tabs.get.mockImplementation(async (id: number) => {
        if (id === 999) throw new Error('No tab with id 999');
        return { id, index: 0, title: 'T', url: 'https://x.com', windowId: 1 };
      });

      mockChrome.tabs.query.mockResolvedValue([
        { id: 11, index: 0, title: 'A', url: 'https://a.com', windowId: 1, active: true },
      ]);

      const result = await tabs.ensureAttachedTab();
      expect(result.tabId).toBe(11);
      expect(result.recovery).toBeDefined();
      expect(result.recovery!.reason).toBe('stale-attached-tab');
      expect(result.recovery!.previousTabId).toBe(999);
      expect(result.recovery!.newTabId).toBe(11);
      expect(tabs.getAttachedTabId()).toBe(11);
    });

    it('prefers the active visible tab in the same window as the stale tab', async () => {
      // The stale tab's windowId is known from tabs.query result (since .get fails, we fall back)
      sessionContext.attachedTabId = 777;
      mockChrome.tabs.get.mockRejectedValue(new Error('No tab'));

      mockChrome.tabs.query.mockResolvedValue([
        { id: 40, index: 0, title: 'other-win active', url: 'https://o.com', windowId: 2, active: true },
        { id: 50, index: 0, title: 'same-win inactive', url: 'https://s.com', windowId: 1, active: false },
        { id: 60, index: 1, title: 'same-win active', url: 'https://s2.com', windowId: 1, active: true },
      ]);

      // windows.getCurrent returns windowId 1
      mockChrome.windows.getCurrent.mockResolvedValue({ id: 1, type: 'normal', focused: true });

      const result = await tabs.ensureAttachedTab();
      expect(result.tabId).toBe(60);
    });

    it('falls back to any automatable visible tab when no active one matches', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 70, index: 0, title: 'A', url: 'https://a.com', windowId: 1, active: false },
      ]);

      const result = await tabs.ensureAttachedTab();
      expect(result.tabId).toBe(70);
      expect(result.recovery).toBeDefined();
    });

    it('skips chrome:// and chrome-extension:// tabs when recovering', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 80, index: 0, title: 'settings', url: 'chrome://settings', windowId: 1, active: true },
        { id: 81, index: 1, title: 'ext', url: 'chrome-extension://abc/', windowId: 1, active: false },
        { id: 82, index: 2, title: 'real', url: 'https://real.com', windowId: 1, active: false },
      ]);

      const result = await tabs.ensureAttachedTab();
      expect(result.tabId).toBe(82);
    });

    it('throws a clear error when no tabs are available for recovery', async () => {
      mockChrome.tabs.query.mockResolvedValue([]);
      await expect(tabs.ensureAttachedTab()).rejects.toThrow(
        /No attached tab and no recoverable tabs/i
      );
    });

    it('throws a clear error when only non-automatable tabs exist', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 90, index: 0, title: 'x', url: 'chrome://settings', windowId: 1, active: true },
      ]);
      await expect(tabs.ensureAttachedTab()).rejects.toThrow(
        /No attached tab and no recoverable tabs/i
      );
    });

    it('logs recovery via logger so audit can pick it up', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 100, index: 0, title: 'A', url: 'https://a.com', windowId: 1, active: true },
      ]);

      await tabs.ensureAttachedTab();
      const logCalls = (mockLogger.log as any).mock.calls.map((c: any[]) => String(c[0]));
      expect(logCalls.some((m: string) => /recover/i.test(m))).toBe(true);
    });

    it('updates the icon manager on recovery', async () => {
      mockChrome.tabs.query.mockResolvedValue([
        { id: 110, index: 0, title: 'A', url: 'https://a.com', windowId: 1, active: true },
      ]);

      await tabs.ensureAttachedTab();
      expect(mockIconManager.setAttachedTab).toHaveBeenCalledWith(110);
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
    it('disconnect greys group and does not ungroup', async () => {
      mockChrome.tabs.group.mockResolvedValue(42);
      mockChrome.tabGroups.query.mockResolvedValue([
        { id: 42, title: 'proj-abc12', color: 'blue', collapsed: false, windowId: 1 },
      ]);
      mockChrome.tabs.create.mockResolvedValue({
        id: 100, index: 0, title: 't', url: 'https://example.com', groupId: -1, windowId: 1,
      });

      await tabs.createTab({ url: 'https://example.com', _sessionId: 'proj-abc12' });
      mockChrome.tabs.query.mockResolvedValue([
        { id: 100, index: 0, title: 't', url: 'https://example.com', groupId: 42, windowId: 1 },
      ]);
      await tabs.handleSessionDisconnect('proj-abc12');

      expect(mockChrome.tabs.ungroup).not.toHaveBeenCalled();
      expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ color: 'grey' }),
      );
      const stored = mockChrome.storage._data['supersurf.sessionGroupColors'];
      expect(stored?.['proj-abc12']).toBe('blue');
      expect(stored?.['proj-abc12']).not.toBe('grey');
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
