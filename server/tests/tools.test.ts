import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserBridge } from '../src/tools';

// Mock the logger
vi.mock('../src/logger', () => ({
  getLogger: () => ({
    log: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  }),
  createLog: () => (..._args: unknown[]) => {},
}));

// Mock audit logger to avoid filesystem writes during tests
vi.mock('../src/audit-logger', () => ({
  AuditLogger: class {
    write = vi.fn();
    getPath = vi.fn().mockReturnValue('/tmp/audit-test.ndjson');
  },
}));

// Mock experimental registry (used by interaction/navigation handlers)
vi.mock('../src/experimental/index', () => ({
  experimentRegistry: {
    isEnabled: vi.fn().mockReturnValue(false),
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    listAvailable: vi.fn().mockReturnValue(['page_diffing', 'smart_waiting', 'storage_inspection']),
    getStates: vi.fn().mockReturnValue({ page_diffing: false, smart_waiting: false, storage_inspection: false }),
    isAvailable: vi.fn().mockReturnValue(true),
  },
  diffSnapshots: vi.fn().mockReturnValue({ added: [], removed: [], countDelta: 0 }),
  calculateConfidence: vi.fn().mockReturnValue(1.0),
  formatDiffSection: vi.fn().mockReturnValue(''),
  getExperimentalToolSchemas: vi.fn().mockReturnValue([]),
  callExperimentalTool: vi.fn().mockReturnValue(null),
}));

// ── Mock extension transport ──

function createMockExt() {
  return {
    sendCmd: vi.fn().mockResolvedValue({ success: true }),
    connected: true,
    browser: 'chrome',
    buildTime: null,
    onReconnect: null,
    onTabInfoUpdate: null,
    start: vi.fn(),
    stop: vi.fn(),
    notifyClientId: vi.fn(),
  } as any;
}

function createMockConnectionManager() {
  return {
    setAttachedTab: vi.fn(),
    getAttachedTab: vi.fn().mockReturnValue(null),
    setConnectedBrowserName: vi.fn(),
    setStealthMode: vi.fn(),
    clearAttachedTab: vi.fn(),
    statusHeader: vi.fn().mockReturnValue(''),
    attachedTab: null,
  } as any;
}

describe('BrowserBridge', () => {
  let bridge: BrowserBridge;
  let mockExt: ReturnType<typeof createMockExt>;
  let mockCM: ReturnType<typeof createMockConnectionManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExt = createMockExt();
    mockCM = createMockConnectionManager();
    bridge = new BrowserBridge({}, mockExt);
    bridge.initialize({}, {}, mockCM);
  });

  // ── callTool dispatch ──

  describe('callTool() dispatch', () => {
    it('returns error for unknown tool', async () => {
      const result = await bridge.callTool('nonexistent_tool');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });

    it('returns error when ext is null', async () => {
      const noExtBridge = new BrowserBridge({}, null as any);
      const result = await noExtBridge.callTool('browser_tabs', { action: 'list' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Extension not connected');
    });

    it('dispatches browser_tabs to onBrowserTabs', async () => {
      mockExt.sendCmd.mockResolvedValue({ tabs: [], attachedTabId: null });
      await bridge.callTool('browser_tabs', { action: 'list' });
      expect(mockExt.sendCmd).toHaveBeenCalledWith('getTabs', expect.anything());
    });

    it('dispatches browser_navigate to onNavigate', async () => {
      mockExt.sendCmd.mockResolvedValue({ success: true });
      await bridge.callTool('browser_navigate', { action: 'url', url: 'https://example.com' });
      expect(mockExt.sendCmd).toHaveBeenCalledWith('navigate', expect.objectContaining({ action: 'url' }));
    });

    it('dispatches browser_snapshot to onSnapshot', async () => {
      mockExt.sendCmd.mockResolvedValue({ nodes: [] });
      await bridge.callTool('browser_snapshot');
      expect(mockExt.sendCmd).toHaveBeenCalledWith('snapshot', {});
    });

    it('dispatches browser_evaluate to extension', async () => {
      mockExt.sendCmd.mockResolvedValue('42');
      await bridge.callTool('browser_evaluate', { expression: '1+1' });
      expect(mockExt.sendCmd).toHaveBeenCalledWith('evaluate', expect.objectContaining({ expression: '1+1' }));
    });

    it('dispatches browser_window to extension', async () => {
      mockExt.sendCmd.mockResolvedValue({ success: true });
      await bridge.callTool('browser_window', { action: 'maximize' });
      expect(mockExt.sendCmd).toHaveBeenCalledWith('window', expect.objectContaining({ action: 'maximize' }));
    });
  });

  // ── rawResult mode ──

  describe('rawResult mode', () => {
    it('returns raw data when rawResult is true', async () => {
      mockExt.sendCmd.mockResolvedValue({ nodes: [{ role: { value: 'button' }, name: { value: 'Submit' } }] });
      const result = await bridge.callTool('browser_snapshot', {}, { rawResult: true });
      expect(result.nodes).toBeDefined();
    });
  });

  // ── Error handling ──

  describe('error handling', () => {
    it('wraps thrown errors in MCP error format', async () => {
      mockExt.sendCmd.mockRejectedValue(new Error('Connection lost'));
      const result = await bridge.callTool('browser_snapshot');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Connection lost');
    });

    it('detects extension conflict errors', async () => {
      mockExt.sendCmd.mockRejectedValue(new Error('Cannot attach debugger: another extension conflict'));
      const result = await bridge.callTool('browser_snapshot');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('extension conflict');
    });

    it('returns rawResult error format', async () => {
      mockExt.sendCmd.mockRejectedValue(new Error('fail'));
      const result = await bridge.callTool('browser_snapshot', {}, { rawResult: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('fail');
    });

    it('prioritizes exception.description in evalExpr error path', async () => {
      // evalExpr is used by ctx.eval() — test via forwardCDPCommand response
      // Simulate CDP returning exceptionDetails with rich description
      mockExt.sendCmd.mockResolvedValue({
        exceptionDetails: {
          text: 'Uncaught',
          exception: {
            description: 'ReferenceError: foo is not defined\n    at <anonymous>:1:1',
            className: 'ReferenceError',
          },
        },
      });
      // browser_navigate with action 'back' calls ctx.eval('window.history.back()')
      // which routes through evalExpr → cdp → forwardCDPCommand
      const result = await bridge.callTool('browser_navigate', { action: 'back' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ReferenceError: foo is not defined');
    });
  });

  // ── listTools ──

  describe('listTools()', () => {
    it('returns tool schemas array', async () => {
      const tools = await bridge.listTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);

      const names = tools.map(t => t.name);
      expect(names).toContain('browser_tabs');
      expect(names).toContain('browser_navigate');
      expect(names).toContain('browser_interact');
      expect(names).toContain('browser_snapshot');
      expect(names).toContain('browser_take_screenshot');
    });
  });

  // ── inline screenshot ──

  describe('inline screenshot', () => {
    it('appends image block when screenshot=true on eligible tool', async () => {
      // First call: navigate handler, second call: screenshot capture
      mockExt.sendCmd
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ data: 'fakeBase64Data', mimeType: 'image/jpeg' });

      const result = await bridge.callTool('browser_navigate', {
        action: 'url',
        url: 'https://example.com',
        screenshot: true,
      });

      expect(result.content.length).toBeGreaterThanOrEqual(2);
      const imageBlock = result.content.find((c: any) => c.type === 'image');
      expect(imageBlock).toBeDefined();
      expect(imageBlock.data).toBeTruthy();
      expect(imageBlock.mimeType).toContain('image/');
    });

    it('does not append screenshot when screenshot=false', async () => {
      mockExt.sendCmd.mockResolvedValue({ success: true });

      const result = await bridge.callTool('browser_navigate', {
        action: 'url',
        url: 'https://example.com',
        screenshot: false,
      });

      const imageBlock = result.content?.find((c: any) => c.type === 'image');
      expect(imageBlock).toBeUndefined();
    });

    it('does not append screenshot on ineligible tool', async () => {
      mockExt.sendCmd
        .mockResolvedValueOnce({ nodes: [] })
        .mockResolvedValueOnce({ data: 'fakeBase64Data', mimeType: 'image/jpeg' });

      const result = await bridge.callTool('browser_snapshot', { screenshot: true });

      const imageBlock = result.content?.find((c: any) => c.type === 'image');
      expect(imageBlock).toBeUndefined();
    });

    it('skips screenshot on error results', async () => {
      mockExt.sendCmd.mockRejectedValue(new Error('Something broke'));

      const result = await bridge.callTool('browser_navigate', {
        action: 'url',
        url: 'https://example.com',
        screenshot: true,
      });

      expect(result.isError).toBe(true);
      const imageBlock = result.content?.find((c: any) => c.type === 'image');
      expect(imageBlock).toBeUndefined();
    });
  });

  // ── serverClosed ──

  describe('serverClosed()', () => {
    it('does not throw', () => {
      expect(() => bridge.serverClosed()).not.toThrow();
    });
  });
});
