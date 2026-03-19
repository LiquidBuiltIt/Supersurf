import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserBridge } from '../src/tools';
import { experimentRegistry } from '../src/experimental/index';

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

describe('browser_storage (storage_inspection experiment)', () => {
  let bridge: BrowserBridge;
  let mockExt: ReturnType<typeof createMockExt>;
  let mockCM: ReturnType<typeof createMockConnectionManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    experimentRegistry.reset();
    mockExt = createMockExt();
    mockCM = createMockConnectionManager();
    bridge = new BrowserBridge({}, mockExt);
    bridge.initialize({}, {}, mockCM);
  });

  // ── Experiment gate ──

  describe('experiment gate', () => {
    it('returns error when storage_inspection is disabled', async () => {
      const result = await bridge.callTool('browser_storage', {
        type: 'localStorage',
        action: 'list',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('storage_inspection');
      expect(result.content[0].text).toContain('not enabled');
    });

    it('returns rawResult error when disabled', async () => {
      const result = await bridge.callTool(
        'browser_storage',
        { type: 'localStorage', action: 'list' },
        { rawResult: true }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('storage_inspection');
    });
  });

  // ── Actions (with experiment enabled) ──

  describe('actions', () => {
    beforeEach(() => {
      experimentRegistry.enable('storage_inspection');
    });

    it('list — returns all entries', async () => {
      mockExt.sendCmd.mockResolvedValue({
        result: {
          value: { length: 2, entries: { foo: 'bar', baz: 'qux' } },
        },
      });
      const result = await bridge.callTool('browser_storage', {
        type: 'localStorage',
        action: 'list',
      });
      expect(mockExt.sendCmd).toHaveBeenCalledWith(
        'forwardCDPCommand',
        expect.objectContaining({
          method: 'Runtime.evaluate',
          params: expect.objectContaining({
            expression: expect.stringContaining('localStorage'),
          }),
        })
      );
      expect(result.isError).toBeUndefined();
    });

    it('get — retrieves a key', async () => {
      mockExt.sendCmd.mockResolvedValue({
        result: { value: 'hello' },
      });
      const result = await bridge.callTool('browser_storage', {
        type: 'sessionStorage',
        action: 'get',
        key: 'myKey',
      });
      expect(mockExt.sendCmd).toHaveBeenCalledWith(
        'forwardCDPCommand',
        expect.objectContaining({
          params: expect.objectContaining({
            expression: expect.stringContaining('sessionStorage.getItem'),
          }),
        })
      );
      expect(result.isError).toBeUndefined();
    });

    it('set — stores a value', async () => {
      mockExt.sendCmd.mockResolvedValue({ result: { value: undefined } });
      const result = await bridge.callTool('browser_storage', {
        type: 'localStorage',
        action: 'set',
        key: 'testKey',
        value: 'testVal',
      });
      expect(mockExt.sendCmd).toHaveBeenCalledWith(
        'forwardCDPCommand',
        expect.objectContaining({
          params: expect.objectContaining({
            expression: expect.stringContaining('localStorage.setItem'),
          }),
        })
      );
      expect(result.isError).toBeUndefined();
    });

    it('delete — removes a key', async () => {
      // First call checks existence, second removes
      mockExt.sendCmd
        .mockResolvedValueOnce({ result: { value: true } })
        .mockResolvedValueOnce({ result: { value: undefined } });
      const result = await bridge.callTool('browser_storage', {
        type: 'localStorage',
        action: 'delete',
        key: 'removeMe',
      });
      expect(mockExt.sendCmd).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeUndefined();
    });

    it('clear — clears all storage', async () => {
      mockExt.sendCmd
        .mockResolvedValueOnce({ result: { value: 5 } })   // length
        .mockResolvedValueOnce({ result: { value: undefined } }); // clear
      const result = await bridge.callTool('browser_storage', {
        type: 'sessionStorage',
        action: 'clear',
      });
      expect(mockExt.sendCmd).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeUndefined();
    });
  });

  // ── Validation ──

  describe('validation', () => {
    beforeEach(() => {
      experimentRegistry.enable('storage_inspection');
    });

    it('rejects invalid storage type', async () => {
      const result = await bridge.callTool('browser_storage', {
        type: 'indexedDB',
        action: 'list',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid storage type');
    });

    it('rejects missing key for get', async () => {
      const result = await bridge.callTool('browser_storage', {
        type: 'localStorage',
        action: 'get',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('requires a "key"');
    });

    it('rejects missing key for delete', async () => {
      const result = await bridge.callTool('browser_storage', {
        type: 'localStorage',
        action: 'delete',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('requires a "key"');
    });

    it('rejects missing value for set', async () => {
      const result = await bridge.callTool('browser_storage', {
        type: 'localStorage',
        action: 'set',
        key: 'test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('requires a "value"');
    });
  });

  // ── Schema presence ──

  describe('schema', () => {
    it('browser_storage appears in listTools', async () => {
      const tools = await bridge.listTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('browser_storage');
    });
  });
});
