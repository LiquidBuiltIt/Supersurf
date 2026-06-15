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

// Mock usage-metrics logger to avoid filesystem writes during tests
vi.mock('../src/usage-metrics-logger', () => ({
  UsageMetricsLogger: class {
    filePath = '/tmp/metrics-test.ndjson';
    write = vi.fn();
    getPath = vi.fn().mockReturnValue('/tmp/metrics-test.ndjson');
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
    consumeDialogEvents: vi.fn().mockReturnValue([]),
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
      // Disable secure_eval for this dispatch test — it only verifies the
      // browser_evaluate tool reaches the `evaluate` extension command.
      // (secure_eval-on tests live in secure-eval.test.ts.)
      const { ConfigService } = await import('shared');
      const optedOutBridge = new BrowserBridge(
        { configService: new ConfigService({ cli: {}, env: {}, file: { security: { secure_eval: false } } }) },
        mockExt,
      );
      optedOutBridge.initialize({}, {}, mockCM);
      mockExt.sendCmd.mockResolvedValue('42');
      await optedOutBridge.callTool('browser_evaluate', { expression: '1+1', purpose: 'arithmetic probe' });
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

    it('rewrites "Target crashed" with renderer-crash recovery guidance', async () => {
      mockExt.sendCmd.mockRejectedValue(new Error('Target crashed'));
      const result = await bridge.callTool('browser_snapshot');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('renderer process crashed');
      expect(result.content[0].text).toContain('browser_tabs');
    });

    it('rewrites "CDP timeout: Runtime.evaluate" with hang/recovery guidance', async () => {
      mockExt.sendCmd.mockRejectedValue(new Error('CDP timeout: Runtime.evaluate (50000ms)'));
      const result = await bridge.callTool('browser_snapshot');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('JavaScript evaluation');
      expect(result.content[0].text).toContain('timed out');
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
      // First call: navigate handler, second: chrome-error probe (Runtime.evaluate), third: screenshot capture
      mockExt.sendCmd
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ result: { value: JSON.stringify({ bodyClass: 'home', href: 'https://example.com/' }) } })
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

  // ── tab recovery envelope ──

  describe('tab recovery envelope', () => {
    it('prepends recovery note when result has _recovery field', async () => {
      mockExt.sendCmd.mockResolvedValue({
        success: true,
        url: 'https://bar.com',
        _recovery: {
          reason: 'stale-attached-tab',
          previousTabId: 48291,
          newTabId: 48305,
          url: 'https://bar.com',
        },
      });

      const result = await bridge.callTool('browser_navigate', { action: 'url', url: 'https://bar.com' });

      const text = result.content[0].text;
      expect(text).toMatch(/↻ tab recovered/);
      expect(text).toContain('48291');
      expect(text).toContain('48305');
      expect(text).toContain('https://bar.com');
    });

    it('strips _recovery from the JSON body so it is not duplicated', async () => {
      mockExt.sendCmd.mockResolvedValue({
        success: true,
        url: 'https://x.test',
        _recovery: {
          reason: 'stale-attached-tab',
          previousTabId: 1,
          newTabId: 2,
          url: 'https://x.test',
        },
      });

      const result = await bridge.callTool('browser_navigate', { action: 'url', url: 'https://x.test' });
      const text = result.content[0].text;

      // The one-line note appears once, but _recovery shouldn't be dumped as JSON too
      expect(text).not.toMatch(/"_recovery"/);
    });

    it('handles primitive-wrap envelope { value, _recovery }', async () => {
      mockExt.sendCmd.mockResolvedValue({
        value: 'some-string',
        _recovery: {
          reason: 'stale-attached-tab',
          previousTabId: 10,
          newTabId: 20,
          url: 'https://y.test',
        },
      });

      const result = await bridge.callTool('browser_navigate', { action: 'url', url: 'https://y.test' });
      const text = result.content[0].text;
      expect(text).toMatch(/↻ tab recovered/);
      expect(text).toContain('10');
      expect(text).toContain('20');
    });

    it('does nothing when result has no _recovery field', async () => {
      mockExt.sendCmd.mockResolvedValue({ success: true, url: 'https://bar.com' });

      const result = await bridge.callTool('browser_navigate', { action: 'url', url: 'https://bar.com' });
      const text = result.content[0].text;
      expect(text).not.toMatch(/↻ tab recovered/);
    });

    it('does not emit recovery note in rawResult mode', async () => {
      mockExt.sendCmd.mockResolvedValue({
        success: true,
        url: 'https://x.test',
        _recovery: {
          reason: 'stale-attached-tab',
          previousTabId: 1,
          newTabId: 2,
          url: 'https://x.test',
        },
      });

      const result = await bridge.callTool('browser_navigate', { action: 'url', url: 'https://x.test' }, { rawResult: true });
      // rawResult passes through untouched — _recovery preserved for programmatic consumers
      expect(result._recovery).toBeDefined();
      expect(result._recovery.previousTabId).toBe(1);
    });
  });

  // ── held-dialog aggregation (via transport.consumeDialogEvents) ──

  describe('held-dialog aggregation', () => {
    it('prepends notice when transport reports held dialogs', async () => {
      mockCM.statusHeader.mockReturnValue('STATUS\n');
      mockExt.sendCmd.mockResolvedValue({ message: 'ok' });
      mockExt.consumeDialogEvents.mockReturnValue([
        { type: 'alert', message: 'Upload complete', defaultPrompt: '', url: 'https://x.test/', hasBrowserHandler: true, timestamp: 123 },
        { type: 'confirm', message: 'Submit?', defaultPrompt: '', url: 'https://x.test/', hasBrowserHandler: true, timestamp: 456 },
      ]);

      const result = await bridge.callTool('browser_snapshot', {});
      const text = result.content[0].text;

      expect(text).toContain('A native alert dialog is OPEN');
      expect(text).toContain('Upload complete');
      expect(text).toContain('A native confirm dialog is OPEN');
      expect(text).toContain('Submit?');
      expect(text).toContain('browser_handle_dialog');
    });

    it('does nothing when the buffer is empty', async () => {
      mockExt.sendCmd.mockResolvedValue({ message: 'ok' });
      mockExt.consumeDialogEvents.mockReturnValue([]);
      const result = await bridge.callTool('browser_snapshot', {});
      expect(result.content[0].text).not.toContain('is OPEN and blocking');
    });

    it('drains buffer once per dispatch (consumeDialogEvents is called)', async () => {
      mockExt.sendCmd.mockResolvedValue({ message: 'ok' });
      mockExt.consumeDialogEvents.mockReturnValue([
        { type: 'alert', message: 'hi', defaultPrompt: '', url: 'https://x.test/', hasBrowserHandler: true, timestamp: 1 },
      ]);

      await bridge.callTool('browser_snapshot', {});
      expect(mockExt.consumeDialogEvents).toHaveBeenCalled();
    });

    it('does not prepend dialog notice in rawResult mode', async () => {
      mockExt.sendCmd.mockResolvedValue({ message: 'ok' });
      mockExt.consumeDialogEvents.mockReturnValue([
        { type: 'alert', message: 'hi', defaultPrompt: '', url: 'https://x.test/', hasBrowserHandler: true, timestamp: 1 },
      ]);

      const result = await bridge.callTool('browser_snapshot', {}, { rawResult: true });
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      expect(text).not.toContain('is OPEN and blocking');
    });

    it('prepends notice to MCP-envelope tools that build their own content (e.g. snapshot)', async () => {
      mockExt.sendCmd.mockResolvedValue({ message: 'ok' });
      mockExt.consumeDialogEvents.mockReturnValue([
        { type: 'beforeunload', message: '', defaultPrompt: '', url: 'https://x.test/', hasBrowserHandler: true, timestamp: 9 },
      ]);

      const result = await bridge.callTool('browser_snapshot', {});
      const text = result.content[0].text;
      expect(text).toContain('A native beforeunload dialog is OPEN');
    });

    it('still prepends notice when the result is an error', async () => {
      mockExt.sendCmd.mockRejectedValue(new Error('boom'));
      mockExt.consumeDialogEvents.mockReturnValue([
        { type: 'alert', message: 'late', defaultPrompt: '', url: 'https://x.test/', hasBrowserHandler: true, timestamp: 2 },
      ]);

      const result = await bridge.callTool('browser_snapshot', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('A native alert dialog is OPEN');
    });
  });

  // ── serverClosed ──

  describe('serverClosed()', () => {
    it('does not throw', () => {
      expect(() => bridge.serverClosed()).not.toThrow();
    });
  });
});

describe('tool tips integration', () => {
  it('appends tip when evaluate does a JS click', async () => {
    const ext = createMockExt();
    ext.sendCmd.mockResolvedValue('clicked');
    const bridge = new BrowserBridge({}, ext);
    await bridge.initialize({}, {}, createMockConnectionManager());

    const result = await bridge.callTool('browser_evaluate', {
      expression: `document.querySelector('button').click()`,
    });

    const text = result.content[0].text;
    expect(text).toContain('Tip:');
    expect(text).toContain('browser_interact');
  });

  it('does not append tip when evaluate does safe read', async () => {
    const ext = createMockExt();
    ext.sendCmd.mockResolvedValue('42');
    const bridge = new BrowserBridge({}, ext);
    await bridge.initialize({}, {}, createMockConnectionManager());

    const result = await bridge.callTool('browser_evaluate', {
      expression: `document.title`,
    });

    const text = result.content[0].text;
    expect(text).not.toContain('Tip:');
  });

  it('appends tip on interact element-not-found error', async () => {
    const ext = createMockExt();
    ext.sendCmd.mockRejectedValue(new Error('Element not found: `button.missing`'));
    const bridge = new BrowserBridge({}, ext);
    await bridge.initialize({}, {}, createMockConnectionManager());

    const result = await bridge.callTool('browser_interact', {
      actions: [{ type: 'click', selector: 'button.missing' }],
    });

    const text = result.content[0].text;
    expect(text).toContain('Tip:');
    expect(text).toContain('browser_lookup');
  });
});
