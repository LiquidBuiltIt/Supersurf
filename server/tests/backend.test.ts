import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager, BackendConfig } from '../src/backend';
import { ConfigService } from 'shared';

// ---- Mocks ----

// Mock the logger module
vi.mock('../src/logger', () => ({
  getLogger: () => ({
    log: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  }),
  getRegistry: () => ({
    debugMode: false,
    setSessionLog: vi.fn().mockReturnValue({ logFilePath: '/tmp/test.log', enable: vi.fn(), log: vi.fn() }),
    clearSessionLog: vi.fn(),
    getLogger: vi.fn().mockReturnValue({ log: vi.fn(), enable: vi.fn(), disable: vi.fn() }),
  }),
  createLog: () => (..._args: unknown[]) => {},
}));

// Mock experimental registry
vi.mock('../src/experimental/index', () => ({
  experimentRegistry: {
    listAvailable: vi.fn().mockReturnValue(['page_diffing', 'smart_waiting']),
    enable: vi.fn(),
    disable: vi.fn(),
    toggle: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    bind: vi.fn(),
    unbind: vi.fn(),
    getStates: vi.fn().mockReturnValue({ page_diffing: false, smart_waiting: false }),
    isAvailable: vi.fn().mockImplementation((f: string) => ['page_diffing', 'smart_waiting'].includes(f)),
  },
  applyInitialState: vi.fn(),
}));

// Mock DaemonClient (replaces ExtensionServer mock)
const mockDaemonClientInstance = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  notifyClientId: vi.fn(),
  sendCmd: vi.fn().mockResolvedValue(undefined),
  connected: true,
  buildTime: null as string | null,
  browser: 'chrome',
  onReconnect: null as (() => void) | null,
  onTabInfoUpdate: null as ((tabInfo: any) => void) | null,
};

vi.mock('../src/daemon-client', () => ({
  DaemonClient: vi.fn(function () {
    return mockDaemonClientInstance;
  }),
}));

// Mock daemon-spawn
vi.mock('../src/daemon-spawn', () => ({
  ensureDaemon: vi.fn().mockResolvedValue(undefined),
  getSockPath: vi.fn().mockReturnValue('/tmp/test-daemon.sock'),
}));

// Mock UsageMetricsLogger
const mockMetricsWrite = vi.fn();
const mockMetricsGetPath = vi.fn().mockReturnValue('/tmp/metrics.ndjson');
vi.mock('../src/usage-metrics-logger', () => ({
  UsageMetricsLogger: vi.fn(function (this: any) {
    this.filePath = '/tmp/metrics.ndjson';
    this.write = mockMetricsWrite;
    this.getPath = mockMetricsGetPath;
    return this;
  }),
  redactParams: vi.fn((p: any) => p),
}));

// Mock the tools module (lazy import) — BrowserBridge
const mockBridgeInstance = {
  initialize: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue([
    { name: 'browser_tabs', description: 'Tab management', inputSchema: { type: 'object' } },
  ]),
  callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
  serverClosed: vi.fn(),
};

vi.mock('../src/tools', () => {
  const MockBrowserBridge = vi.fn(function (this: any) {
    Object.assign(this, mockBridgeInstance);
  });
  return { BrowserBridge: MockBrowserBridge };
});

// ---- Helpers ----

function makeConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    debug: false,
    port: 5555,
    server: { name: 'supersurf', version: '0.1.0' },
    configService: new ConfigService({
      cli: {},
      env: {},
      file: { logging: { usage_metrics: true } },
    }),
    ...overrides,
  };
}

function makeMockServer() {
  return {
    sendToolsListChanged: vi.fn().mockResolvedValue(undefined),
  } as any;
}

// ---- Tests ----

describe('ConnectionManager', () => {
  let backend: ConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock state for DaemonClient instance
    mockDaemonClientInstance.start.mockResolvedValue(undefined);
    mockDaemonClientInstance.stop.mockResolvedValue(undefined);
    mockDaemonClientInstance.buildTime = null;
    mockDaemonClientInstance.browser = 'chrome';
    mockDaemonClientInstance.onReconnect = null;
    mockDaemonClientInstance.onTabInfoUpdate = null;
    mockMetricsWrite.mockClear();

    backend = new ConnectionManager(makeConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Constructor ----

  describe('constructor', () => {
    it('starts in passive state', async () => {
      const result = await backend.callTool('status', {}, { rawResult: true });
      expect(result.state).toBe('passive');
    });

    it('stores config correctly', async () => {
      const header = backend.statusHeader();
      expect(header).toContain('v0.1.0');
    });
  });

  // ---- initialize ----

  describe('initialize()', () => {
    it('stores server and clientInfo', async () => {
      const server = makeMockServer();
      const clientInfo = { name: 'test-client', version: '1.0' };
      await backend.initialize(server, clientInfo);

      // Verify server is stored by connecting — it should call sendToolsListChanged
      await backend.callTool('connect', { client_id: 'test' });
      expect(server.sendToolsListChanged).toHaveBeenCalled();
    });
  });

  // ---- callTool('connect') ----

  describe('callTool("connect")', () => {
    beforeEach(async () => {
      await backend.initialize(makeMockServer(), {});
    });

    it('transitions to active state', async () => {
      const result = await backend.callTool('connect', { client_id: 'my-project' }, { rawResult: true });

      expect(result.success).toBe(true);
      expect(result.state).toBe('active');
      expect(result.client_id).toBe('my-project');
      expect(result.port).toBe(5555);
    });

    it('spawns daemon and creates DaemonClient', async () => {
      const { ensureDaemon } = await import('../src/daemon-spawn');
      const { DaemonClient } = await import('../src/daemon-client');

      await backend.callTool('connect', { client_id: 'test' });

      expect(ensureDaemon).toHaveBeenCalled();
      expect(DaemonClient).toHaveBeenCalled();
      expect(mockDaemonClientInstance.start).toHaveBeenCalled();
    });

    it('returns error without client_id', async () => {
      const result = await backend.callTool('connect', {}, { rawResult: true });
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing_client_id');
    });

    it('returns error with empty client_id', async () => {
      const result = await backend.callTool('connect', { client_id: '   ' }, { rawResult: true });
      expect(result.success).toBe(false);
      expect(result.error).toBe('missing_client_id');
    });

    it('returns MCP-formatted error without client_id when rawResult is false', async () => {
      const result = await backend.callTool('connect', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('client_id');
    });

    it('returns "already connected" when already active', async () => {
      await backend.callTool('connect', { client_id: 'test' });

      const result = await backend.callTool('connect', { client_id: 'test' }, { rawResult: true });
      expect(result.already_connected).toBe(true);
      expect(result.state).toBe('active');
    });

    it('returns MCP-formatted "already connected" when rawResult is false', async () => {
      await backend.callTool('connect', { client_id: 'test' });

      const result = await backend.callTool('connect', { client_id: 'other' });
      expect(result.content[0].text).toContain('Already Connected');
    });

    it('initializes BrowserBridge with correct args', async () => {
      const { BrowserBridge } = await import('../src/tools');
      await backend.callTool('connect', { client_id: 'test' });
      expect(BrowserBridge).toHaveBeenCalled();
      expect(mockBridgeInstance.initialize).toHaveBeenCalled();
    });

    it('handles daemon connection failure gracefully', async () => {
      mockDaemonClientInstance.start.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await backend.callTool('connect', { client_id: 'test' }, { rawResult: true });
      expect(result.success).toBe(false);
      expect(result.error).toBe('connection_failed');
    });

    it('trims whitespace from client_id', async () => {
      const result = await backend.callTool('connect', { client_id: '  trimmed  ' }, { rawResult: true });
      expect(result.client_id).toBe('trimmed');
    });
  });

  // ---- callTool('disconnect') ----

  describe('callTool("disconnect")', () => {
    beforeEach(async () => {
      await backend.initialize(makeMockServer(), {});
    });

    it('transitions back to passive from active', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      const result = await backend.callTool('disconnect', {}, { rawResult: true });

      expect(result.success).toBe(true);
      expect(result.state).toBe('passive');
    });

    it('stops DaemonClient on disconnect', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      await backend.callTool('disconnect');
      expect(mockDaemonClientInstance.stop).toHaveBeenCalled();
    });

    it('calls serverClosed on bridge', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      await backend.callTool('disconnect');
      expect(mockBridgeInstance.serverClosed).toHaveBeenCalled();
    });

    it('returns "already disconnected" when passive', async () => {
      const result = await backend.callTool('disconnect', {}, { rawResult: true });
      expect(result.already_disconnected).toBe(true);
      expect(result.state).toBe('passive');
    });

    it('returns MCP-formatted "already disconnected" when rawResult is false', async () => {
      const result = await backend.callTool('disconnect');
      expect(result.content[0].text).toContain('Already Disconnected');
    });

    it('clears attached tab and browser name', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      backend.setAttachedTab({ id: 1, index: 0, title: 'Test', url: 'http://test.com' });
      backend.setConnectedBrowserName('Chrome');

      await backend.callTool('disconnect');

      const status = await backend.callTool('status', {}, { rawResult: true });
      expect(status.attached_tab).toBeNull();
      expect(status.browser).toBeNull();
    });
  });

  // ---- callTool('status') ----

  describe('callTool("status")', () => {
    beforeEach(async () => {
      await backend.initialize(makeMockServer(), {});
    });

    it('returns correct state info for passive', async () => {
      const result = await backend.callTool('status', {}, { rawResult: true });
      expect(result.state).toBe('passive');
      expect(result.browser).toBeNull();
      expect(result.client_id).toBeNull();
      expect(result.attached_tab).toBeNull();
    });

    it('returns MCP-formatted passive status', async () => {
      const result = await backend.callTool('status');
      expect(result.content[0].text).toContain('Disconnected');
    });

    it('returns correct state info for active', async () => {
      await backend.callTool('connect', { client_id: 'my-project' });

      const result = await backend.callTool('status', {}, { rawResult: true });
      expect(result.state).toBe('active');
      expect(result.browser).toBe('chrome');
      expect(result.client_id).toBe('my-project');
    });

    it('includes attached tab info when available', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      backend.setAttachedTab({ id: 1, index: 3, title: 'Google', url: 'https://google.com' });

      const result = await backend.callTool('status', {}, { rawResult: true });
      expect(result.attached_tab).toEqual({
        index: 3,
        title: 'Google',
        url: 'https://google.com',
      });
    });

    it('shows "No tab attached" in MCP format when no tab', async () => {
      await backend.callTool('connect', { client_id: 'test' });

      const result = await backend.callTool('status');
      expect(result.content[0].text).toContain('No tab attached');
    });
  });

  // ---- callTool('experimental_features') removed in v2.0.0 ----

  describe('callTool("experimental_features") removed in v2.0.0', () => {
    beforeEach(async () => {
      await backend.initialize(makeMockServer(), {});
    });

    it('returns error for experimental_features call (removed in v2)', async () => {
      const res = await backend.callTool('experimental_features', { page_diffing: true });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/removed.*v2/i);
    });

    it('returns rawResult error for experimental_features call', async () => {
      const res = await backend.callTool('experimental_features', { page_diffing: true }, { rawResult: true });
      expect(res.success).toBe(false);
      expect(res.error).toBe('removed');
      expect(res.message).toMatch(/v2\.0\.0/);
    });
  });

  // ---- callTool with unknown tool when not active ----

  describe('callTool with unknown tool when not active', () => {
    it('returns error (rawResult)', async () => {
      const result = await backend.callTool('browser_tabs', { action: 'list' }, { rawResult: true });
      expect(result.success).toBe(false);
      expect(result.error).toBe('not_enabled');
    });

    it('returns MCP-formatted error', async () => {
      const result = await backend.callTool('browser_tabs', { action: 'list' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Not Active');
    });
  });

  // ---- callTool with browser tool when active ----

  describe('callTool with browser tool when active', () => {
    beforeEach(async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
    });

    it('forwards to bridge', async () => {
      await backend.callTool('browser_tabs', { action: 'list' });
      expect(mockBridgeInstance.callTool).toHaveBeenCalledWith(
        'browser_tabs',
        { action: 'list' },
        {}
      );
    });
  });

  // ---- callTool('profile_*') ----

  describe('callTool profile tools', () => {
    beforeEach(async () => {
      await backend.initialize(makeMockServer(), {});
    });

    it('forwards profile_create to daemon', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      mockDaemonClientInstance.sendCmd.mockResolvedValueOnce({
        success: true,
        profile: { name: 'test', created: '2026-01-01' },
      });

      const result = await backend.callTool('profile_create', { name: 'test' }, { rawResult: true });
      expect(mockDaemonClientInstance.sendCmd).toHaveBeenCalledWith(
        'profiles.create',
        expect.objectContaining({ name: 'test' }),
        10000,
      );
      expect(result.success).toBe(true);
    });

    it('forwards profile_list to daemon', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      mockDaemonClientInstance.sendCmd.mockResolvedValueOnce({
        profiles: [{ name: 'test', created: '2026-01-01', running: false }],
      });

      const result = await backend.callTool('profile_list', {}, { rawResult: true });
      expect(result.profiles).toHaveLength(1);
    });

    it('forwards profile_delete to daemon', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      mockDaemonClientInstance.sendCmd.mockResolvedValueOnce({ success: true });

      const result = await backend.callTool('profile_delete', { name: 'test' }, { rawResult: true });
      expect(result.success).toBe(true);
    });

    it('handles profile create errors', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      mockDaemonClientInstance.sendCmd.mockRejectedValueOnce(new Error('Profile already exists'));

      const result = await backend.callTool('profile_create', { name: 'test' }, { rawResult: true });
      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
    });
  });

  // ---- callTool('reload_mcp') ----

  describe('callTool("reload_mcp")', () => {
    it('returns error when not in debug mode', () => {
      const result = (backend as any).callTool('reload_mcp');
      return result.then((r: any) => {
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain('debug mode');
      });
    });

    it('triggers reload in debug mode', async () => {
      const debugBackend = new ConnectionManager(makeConfig({ debug: true }));
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      vi.useFakeTimers();

      const result = await debugBackend.callTool('reload_mcp', {}, { rawResult: true });
      expect(result.success).toBe(true);
      expect(result.message).toBe('Reloading...');

      vi.advanceTimersByTime(200);
      expect(exitSpy).toHaveBeenCalledWith(42);

      vi.useRealTimers();
      exitSpy.mockRestore();
    });

    it('returns MCP-formatted reload message in debug mode', async () => {
      const debugBackend = new ConnectionManager(makeConfig({ debug: true }));
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      vi.useFakeTimers();

      const result = await debugBackend.callTool('reload_mcp');
      expect(result.content[0].text).toContain('Reloading');

      vi.advanceTimersByTime(200);
      vi.useRealTimers();
      exitSpy.mockRestore();
    });
  });

  // ---- statusHeader ----

  describe('statusHeader()', () => {
    it('returns correct format for passive state', () => {
      const header = backend.statusHeader();
      expect(header).toContain('v0.1.0');
      expect(header).toContain('Disabled');
      expect(header).toContain('---');
    });

    it('returns correct format for active state without tab', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });

      const header = backend.statusHeader();
      expect(header).toContain('v0.1.0');
      expect(header).toContain('No tab attached');
    });

    it('includes tab info when attached', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
      backend.setAttachedTab({
        id: 1,
        index: 2,
        title: 'Test Page',
        url: 'https://example.com/page',
      });

      const header = backend.statusHeader();
      expect(header).toContain('Tab 2');
      expect(header).toContain('https://example.com/page');
    });

    it('truncates long URLs', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
      backend.setAttachedTab({
        id: 1,
        index: 0,
        url: 'https://example.com/very/long/path/that/exceeds/fifty/characters/for/sure',
      });

      const header = backend.statusHeader();
      expect(header).toContain('...');
    });

    it('includes tech stack info when present', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
      backend.setAttachedTab({
        id: 1,
        index: 0,
        url: 'https://example.com',
        techStack: {
          frameworks: ['React'],
          libraries: ['jQuery'],
          css: ['Tailwind'],
        },
      });

      const header = backend.statusHeader();
      expect(header).toContain('React');
      expect(header).toContain('jQuery');
      expect(header).toContain('Tailwind');
    });

    it('includes obfuscated CSS warning', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
      backend.setAttachedTab({
        id: 1,
        index: 0,
        url: 'https://example.com',
        techStack: { obfuscatedCSS: true },
      });

      const header = backend.statusHeader();
      expect(header).toContain('Obfuscated CSS');
    });

    it('includes stealth indicator when stealth mode is on', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
      backend.setStealthMode(true);

      const header = backend.statusHeader();
      expect(header).toContain('Stealth');
    });

    it('includes build timestamp in debug mode', async () => {
      const debugBackend = new ConnectionManager(makeConfig({ debug: true }));
      await debugBackend.initialize(makeMockServer(), {});

      mockDaemonClientInstance.buildTime = '2026-01-15T10:30:00.000Z';
      await debugBackend.callTool('connect', { client_id: 'test' });

      const header = debugBackend.statusHeader();
      expect(header).toContain('[');
      expect(header).toContain(']');
    });
  });

  // ---- setAttachedTab / getAttachedTab ----

  describe('setAttachedTab / getAttachedTab', () => {
    it('returns null initially', () => {
      expect(backend.getAttachedTab()).toBeNull();
    });

    it('stores and retrieves tab info', () => {
      const tab = { id: 5, index: 2, title: 'My Tab', url: 'https://foo.com' };
      backend.setAttachedTab(tab);
      expect(backend.getAttachedTab()).toEqual(tab);
    });

    it('can clear tab by setting null', () => {
      backend.setAttachedTab({ id: 1, index: 0 });
      backend.setAttachedTab(null);
      expect(backend.getAttachedTab()).toBeNull();
    });
  });

  // ---- setConnectedBrowserName / setStealthMode ----

  describe('setConnectedBrowserName', () => {
    it('updates the browser name shown in status', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
      backend.setConnectedBrowserName('Firefox');

      const header = backend.statusHeader();
      expect(header).toContain('Firefox');
    });
  });

  describe('setStealthMode', () => {
    it('toggles stealth indicator in header', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });

      backend.setStealthMode(true);
      expect(backend.statusHeader()).toContain('Stealth');

      backend.setStealthMode(false);
      expect(backend.statusHeader()).not.toContain('Stealth');
    });
  });

  // ---- serverClosed ----

  describe('serverClosed()', () => {
    it('cleans up and returns to passive', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });

      await backend.serverClosed();

      const status = await backend.callTool('status', {}, { rawResult: true });
      expect(status.state).toBe('passive');
    });

    it('calls serverClosed on bridge', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });

      await backend.serverClosed();
      expect(mockBridgeInstance.serverClosed).toHaveBeenCalled();
    });

    it('stops DaemonClient', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });

      await backend.serverClosed();
      expect(mockDaemonClientInstance.stop).toHaveBeenCalled();
    });

    it('is safe to call when already passive', async () => {
      await backend.serverClosed();
      const status = await backend.callTool('status', {}, { rawResult: true });
      expect(status.state).toBe('passive');
    });
  });

  // ---- Audit logging of backend tools ----

  describe('audit logging', () => {
    beforeEach(async () => {
      await backend.initialize(makeMockServer(), {});
    });

    it('connect creates a metrics logger and logs the connect call', async () => {
      const { UsageMetricsLogger } = await import('../src/usage-metrics-logger');

      await backend.callTool('connect', { client_id: 'audit-test' });

      expect(UsageMetricsLogger).toHaveBeenCalledWith('audit-test');
      expect(mockMetricsWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          session_id: 'audit-test',
          tool: 'connect',
          result: 'ok',
        })
      );
    });

    it('disconnect logs to the audit logger', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      mockMetricsWrite.mockClear();

      await backend.callTool('disconnect');

      expect(mockMetricsWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'disconnect',
          result: 'ok',
        })
      );
    });

    it('status logs to the audit logger', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      mockMetricsWrite.mockClear();

      await backend.callTool('status');

      expect(mockMetricsWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'status',
          result: 'ok',
        })
      );
    });

    it('status includes attached tab url when available', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      backend.setAttachedTab({ id: 1, index: 0, title: 'Ex', url: 'https://example.com/page' });
      mockMetricsWrite.mockClear();

      await backend.callTool('status');

      expect(mockMetricsWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'status',
          url: 'https://example.com/page',
        })
      );
    });

    it('status omits url when no tab attached', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      mockMetricsWrite.mockClear();

      await backend.callTool('status');

      const entry = mockMetricsWrite.mock.calls[0][0];
      expect(entry.tool).toBe('status');
      expect(entry.url).toBeUndefined();
    });


    it('connect includes client metadata when clientInfo has name/version', async () => {
      await backend.initialize(makeMockServer(), { name: 'claude-desktop', version: '2.1.0' });

      await backend.callTool('connect', { client_id: 'meta-test' });

      expect(mockMetricsWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'connect',
          client: { name: 'claude-desktop', version: '2.1.0' },
        })
      );
    });

    it('failed connect still creates logger and logs the error', async () => {
      const { UsageMetricsLogger } = await import('../src/usage-metrics-logger');
      // Missing client_id triggers a validation error (not a throw)
      const result = await backend.callTool('connect', {}, { rawResult: true });

      expect(result.success).toBe(false);
      // Logger is NOT created when client_id is missing (no session to bind to)
      // But if client_id is present and the daemon fails:
      mockMetricsWrite.mockClear();
      (UsageMetricsLogger as any).mockClear();
      mockDaemonClientInstance.start.mockRejectedValueOnce(new Error('Connection refused'));

      const result2 = await backend.callTool('connect', { client_id: 'fail-test' }, { rawResult: true });
      expect(result2.success).toBe(false);
      expect(UsageMetricsLogger).toHaveBeenCalledWith('fail-test');
      expect(mockMetricsWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'connect',
          result: 'error',
        })
      );
    });
  });

  // ---- listTools ----

  describe('listTools()', () => {
    it('includes connection tools (connect, disconnect, status)', async () => {
      const tools = await backend.listTools();
      const names = tools.map((t: any) => t.name);
      expect(names).toContain('connect');
      expect(names).toContain('disconnect');
      expect(names).toContain('status');
    });

    it('does not advertise experimental_features tool (removed in v2)', async () => {
      const tools = await backend.listTools();
      const names = tools.map((t: any) => t.name);
      expect(names).not.toContain('experimental_features');
    });

    it('includes browser tools from BrowserBridge', async () => {
      const tools = await backend.listTools();
      const names = tools.map((t: any) => t.name);
      expect(names).toContain('browser_tabs');
    });

    it('always includes profile tools', async () => {
      const tools = await backend.listTools();
      const names = tools.map((t: any) => t.name);
      expect(names).toContain('profile_create');
      expect(names).toContain('profile_list');
      expect(names).toContain('profile_delete');
    });

    it('does not include reload_mcp when not in debug mode', async () => {
      const tools = await backend.listTools();
      const names = tools.map((t: any) => t.name);
      expect(names).not.toContain('reload_mcp');
    });

    it('includes reload_mcp in debug mode', async () => {
      const debugBackend = new ConnectionManager(makeConfig({ debug: true }));
      const tools = await debugBackend.listTools();
      const names = tools.map((t: any) => t.name);
      expect(names).toContain('reload_mcp');
    });
  });
});
