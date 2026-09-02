import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onBrowserStorage, browserStorageSchema } from '../src/tools/browser_storage';
import { getToolSchemas } from '../src/tools/schemas';
import type { ToolContext } from '../src/tools/lib/types';
import { BrowserBridge } from '../src/tools';

// Mock the logger
vi.mock('shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('shared')>();
  return {
    ...actual,
    getLogger: () => ({
      log: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
    }),
    createLog: () => (..._args: unknown[]) => {},
  };
});

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
    listAvailable: vi.fn().mockReturnValue(['page_diffing', 'smart_waiting']),
    getStates: vi.fn().mockReturnValue({ page_diffing: false, smart_waiting: false }),
    isAvailable: vi.fn().mockReturnValue(true),
  },
  diffSnapshots: vi.fn().mockReturnValue({ added: [], removed: [], countDelta: 0 }),
  calculateConfidence: vi.fn().mockReturnValue(1.0),
  formatDiffSection: vi.fn().mockReturnValue(''),
  getExperimentalToolSchemas: vi.fn().mockReturnValue([]),
  callExperimentalTool: vi.fn().mockReturnValue(null),
}));

function createMockCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({ success: true }) } as any,
    connectionManager: {
      setAttachedTab: vi.fn(),
      setStealthMode: vi.fn(),
      clearAttachedTab: vi.fn(),
      attachedTab: null,
    },
    cdp: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn().mockResolvedValue({ x: 100, y: 100 }),
    getSelectorExpression: vi.fn((s: string) => `document.querySelector("${s}")`),
    findAlternativeSelectors: vi.fn().mockResolvedValue([]),
    formatResult: vi.fn((_name, result, _opts) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] })),
    error: vi.fn((msg, _opts) => ({ content: [{ type: 'text', text: msg }], isError: true })),
    ...overrides,
  };
}

describe('browser_storage (graduated from storage_inspection experiment)', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  // ── Always-on (no experiment gate) ──

  describe('no experiment gate', () => {
    it('executes without any experiment enabled (graduated v3.5.0)', async () => {
      // No experimentRegistry setup at all — the gate is gone.
      const result = await onBrowserStorage(ctx, { type: 'localStorage', action: 'list' }, {});
      expect(JSON.stringify(result)).not.toContain('experiment');
    });
  });

  // ── Actions ──

  describe('actions', () => {
    it('list — returns all entries', async () => {
      (ctx.eval as any).mockResolvedValue({ length: 2, entries: { foo: 'bar', baz: 'qux' } });
      const result = await onBrowserStorage(ctx, { type: 'localStorage', action: 'list' }, {});
      expect(ctx.eval).toHaveBeenCalledWith(expect.stringContaining('localStorage'));
      expect(ctx.formatResult).toHaveBeenCalledWith(
        'browser_storage',
        expect.objectContaining({ length: 2, entries: { foo: 'bar', baz: 'qux' } }),
        {},
      );
      expect(result.isError).toBeUndefined();
    });

    it('get — retrieves a key', async () => {
      (ctx.eval as any).mockResolvedValue('hello');
      const result = await onBrowserStorage(ctx, { type: 'sessionStorage', action: 'get', key: 'myKey' }, {});
      expect(ctx.eval).toHaveBeenCalledWith(expect.stringContaining('sessionStorage.getItem'));
      expect(ctx.formatResult).toHaveBeenCalledWith(
        'browser_storage',
        { key: 'myKey', value: 'hello', exists: true },
        {},
      );
      expect(result.isError).toBeUndefined();
    });

    it('set — stores a value', async () => {
      const result = await onBrowserStorage(ctx, { type: 'localStorage', action: 'set', key: 'testKey', value: 'testVal' }, {});
      expect(ctx.eval).toHaveBeenCalledWith(expect.stringContaining('localStorage.setItem'));
      expect(result.isError).toBeUndefined();
    });

    it('delete — removes a key', async () => {
      (ctx.eval as any).mockResolvedValueOnce(true).mockResolvedValueOnce(undefined);
      const result = await onBrowserStorage(ctx, { type: 'localStorage', action: 'delete', key: 'removeMe' }, {});
      expect(ctx.eval).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeUndefined();
    });

    it('clear — clears all storage', async () => {
      (ctx.eval as any).mockResolvedValueOnce(5).mockResolvedValueOnce(undefined);
      const result = await onBrowserStorage(ctx, { type: 'sessionStorage', action: 'clear' }, {});
      expect(ctx.eval).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeUndefined();
    });
  });

  // ── Validation ──

  describe('validation', () => {
    it('rejects invalid storage type', async () => {
      const result = await onBrowserStorage(ctx, { type: 'indexedDB', action: 'list' }, {});
      expect(result.isError).toBe(true);
      expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('Invalid storage type'), {});
    });

    it('rejects missing key for get', async () => {
      const result = await onBrowserStorage(ctx, { type: 'localStorage', action: 'get' }, {});
      expect(result.isError).toBe(true);
      expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('requires a "key"'), {});
    });

    it('rejects missing key for delete', async () => {
      const result = await onBrowserStorage(ctx, { type: 'localStorage', action: 'delete' }, {});
      expect(result.isError).toBe(true);
      expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('requires a "key"'), {});
    });

    it('rejects missing value for set', async () => {
      const result = await onBrowserStorage(ctx, { type: 'localStorage', action: 'set', key: 'test' }, {});
      expect(result.isError).toBe(true);
      expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('requires a "value"'), {});
    });
  });

  // ── Schema presence ──

  describe('schema', () => {
    it('browser_storage appears in the core (non-experimental) tool schemas', () => {
      const names = getToolSchemas().map((t) => t.name);
      expect(names).toContain('browser_storage');
    });

    it('schema description no longer mentions the experiment', () => {
      expect(browserStorageSchema.description).not.toContain('experiment');
    });
  });
});

// ── End-to-end dispatch via BrowserBridge ──
//
// The tests above call onBrowserStorage() directly with a hand-built
// ToolContext. This block exercises the real chain instead:
// BrowserBridge.callTool() → tools/lib/dispatcher.ts → handler-registry.ts
// case 'browser_storage' → onBrowserStorage(). Regression guard for the
// handler-registry wiring itself, not just the handler's own logic.

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

describe('browser_storage — BrowserBridge dispatch (end-to-end)', () => {
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

  it('dispatches browser_storage through callTool() to the extension', async () => {
    // onBrowserStorage's "list" action resolves via ctx.eval() → forwardCDPCommand.
    mockExt.sendCmd.mockResolvedValue({
      result: { value: JSON.stringify({ length: 1, entries: { foo: 'bar' } }) },
    });
    const result = await bridge.callTool('browser_storage', { type: 'localStorage', action: 'list' });
    expect(mockExt.sendCmd).toHaveBeenCalledWith('forwardCDPCommand', expect.anything());
    expect(result.isError).toBeUndefined();
  });

  it('appears exactly once in listTools() output', async () => {
    const tools = await bridge.listTools();
    const matches = tools.filter((t) => t.name === 'browser_storage');
    expect(matches).toHaveLength(1);
  });
});
