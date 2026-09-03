import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConnectionManager, BackendConfig } from '../src/backend';
import { ConfigService } from 'shared';
import { setPlaybooksDirForTests, playbookFile } from '../src/playbooks/paths';
import { refreshRegistry, resetRegistryForTests, setValidatorForTests } from '../src/playbooks/registry';
import { ensureDaemon, stopDaemon } from '../src/daemon-spawn';

// ---- Mocks ----


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
    isEnabled: vi.fn().mockReturnValue(false),
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
  version: '0.1.0' as string | null,
  extensionConnected: false,
  extensionVersionError: null as string | null,
  onReconnect: null as (() => void) | null,
  onTabInfoUpdate: null as ((tabInfo: any) => void) | null,
  isConfigDrifted: vi.fn(() => false),
};

vi.mock('shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('shared')>();
  return {
    ...actual,
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
    DaemonClient: vi.fn(function () {
      return mockDaemonClientInstance;
    }),
  };
});

// Mock daemon-spawn
vi.mock('../src/daemon-spawn', () => ({
  ensureDaemon: vi.fn().mockResolvedValue(undefined),
  stopDaemon: vi.fn().mockResolvedValue(undefined),
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
    mockDaemonClientInstance.version = '0.1.0';
    mockDaemonClientInstance.extensionConnected = false;
    mockDaemonClientInstance.extensionVersionError = null;
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
      const { DaemonClient } = await import('shared');

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

    it('refuses to connect when the daemon version mismatches', async () => {
      mockDaemonClientInstance.version = '2.1.0'; // stale daemon still running

      const result = await backend.callTool('connect', { client_id: 'test' }, { rawResult: true });

      expect(result.success).toBe(false);
      expect(result.error).toBe('version_mismatch');
      expect(result.message).toContain('supersurf-daemon@latest restart');
      expect(mockDaemonClientInstance.stop).toHaveBeenCalled();
    });

    it('refuses to connect when the daemon reports no version (pre-v3)', async () => {
      mockDaemonClientInstance.version = null;

      const result = await backend.callTool('connect', { client_id: 'test' }, { rawResult: true });

      expect(result.success).toBe(false);
      expect(result.error).toBe('version_mismatch');
    });

    it('trims whitespace from client_id', async () => {
      const result = await backend.callTool('connect', { client_id: '  trimmed  ' }, { rawResult: true });
      expect(result.client_id).toBe('trimmed');
    });

    it('includes the upgrade notice in the response text when the startup flag is set', async () => {
      const noticeBackend = new ConnectionManager(makeConfig({ showUpgradeNotice: true }));
      await noticeBackend.initialize(makeMockServer(), {});

      const result = await noticeBackend.callTool('connect', { client_id: 'test' });
      expect(result.content[0].text).toContain(
        "Hey! It looks like it's been a while since you've used this tool!",
      );
      expect(result.content[0].text).toContain(
        'https://github.com/LiquidBuiltIt/Supersurf/blob/main/CHANGELOG.md',
      );
    });

    it('omits the upgrade notice when the startup flag is not set', async () => {
      const result = await backend.callTool('connect', { client_id: 'test' });
      expect(result.content[0].text).not.toContain("it's been a while");
    });

    it('refuses connect with a named error when the extension version is rejected', async () => {
      mockDaemonClientInstance.extensionVersionError =
        'Extension version 2.9.0 is not compatible with SuperSurf 3.4.0.';

      const result = await backend.callTool('connect', { client_id: 'test' }, { rawResult: true });

      expect(result.success).toBe(false);
      expect(result.error).toBe('extension_version_mismatch');
      expect(result.message).toContain('not compatible');
      expect(backend.state).toBe('passive');
      // Matches the daemon-version-mismatch precedent above: a refused connect
      // must not leak the daemon socket it opened to find out.
      expect(mockDaemonClientInstance.stop).toHaveBeenCalled();
    });

    it('refuses connect over MCP with an isError content block', async () => {
      mockDaemonClientInstance.extensionVersionError =
        'Extension version 2.9.0 is not compatible with SuperSurf 3.4.0.';

      const result = await backend.callTool('connect', { client_id: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Extension Version Mismatch');
      expect(result.content[0].text).toContain('not compatible');
      expect(backend.state).toBe('passive');
    });

    it('connects normally when extensionVersionError is null', async () => {
      mockDaemonClientInstance.extensionVersionError = null;

      const result = await backend.callTool('connect', { client_id: 'test' }, { rawResult: true });

      expect(result.success).not.toBe(false);
      expect(backend.state).toBe('active');
    });

    it('does not refuse a profile-bound connect over the unmanaged slot error', async () => {
      // session_ack is emitted before any profile binding exists, so its
      // extensionVersionError can only describe the unmanaged slot. Refusing
      // here would blame a browser this session never touches; profiles.connect
      // fast-fails with the correctly scoped message instead.
      mockDaemonClientInstance.extensionVersionError =
        'Extension version 2.9.0 is not compatible with SuperSurf 3.4.0.';

      const result = await backend.callTool(
        'connect',
        { client_id: 'test', profile: 'work' },
        { rawResult: true },
      );

      expect(result.error).not.toBe('extension_version_mismatch');
      expect(backend.state).toBe('active');
    });

    it('does not refuse when a healthy extension still serves the unmanaged slot', async () => {
      // Only the offending socket is closed, so a stale second extension can
      // record a rejection while a good one is still connected.
      mockDaemonClientInstance.extensionVersionError =
        'Extension version 2.9.0 is not compatible with SuperSurf 3.4.0.';
      mockDaemonClientInstance.extensionConnected = true;

      const result = await backend.callTool('connect', { client_id: 'test' }, { rawResult: true });

      expect(result.error).not.toBe('extension_version_mismatch');
      expect(backend.state).toBe('active');
    });
  });

  describe('daemon version mismatch auto-restart', () => {
    it('restarts a stale daemon once and connects on version match', async () => {
      mockDaemonClientInstance.version = '0.0.1-stale';
      // The restart respawns the bundled daemon — model that by having
      // stopDaemon flip the mock daemon to the matching version.
      (stopDaemon as any).mockImplementationOnce(async () => {
        mockDaemonClientInstance.version = '0.1.0';
      });

      await backend.initialize(makeMockServer(), {});
      const result = await backend.callTool('connect', { client_id: 'test' });

      expect(stopDaemon).toHaveBeenCalledTimes(1);
      expect(ensureDaemon).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Connected to Service');
    });

    it('errors with the exact restart command when the mismatch survives the restart', async () => {
      mockDaemonClientInstance.version = '0.0.1-stale';

      await backend.initialize(makeMockServer(), {});
      const result = await backend.callTool('connect', { client_id: 'test' });

      expect(stopDaemon).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Daemon Version Mismatch');
      expect(result.content[0].text).toContain('npx supersurf-daemon@latest restart');
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

  // ---- callTool('playbooks') — passive-state routing ----

  describe('callTool("playbooks") — passive-state routing', () => {
    let pbDir: string;

    function rec(name: string): any {
      return {
        file: playbookFile(name), name, hash: name, valid: true,
        meta: { description: `does ${name}` }, signature: `${name}()`, validatedAt: 1,
      };
    }

    beforeEach(async () => {
      pbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-backend-'));
      setPlaybooksDirForTests(pbDir);
      resetRegistryForTests();
      fs.writeFileSync(playbookFile('flow'), '// ok');
      setValidatorForTests(async () => rec('flow'));
      await refreshRegistry();
      await backend.initialize(makeMockServer(), {});
    });

    afterEach(() => {
      setValidatorForTests(null);
      resetRegistryForTests();
      fs.rmSync(pbDir, { recursive: true, force: true });
    });

    it('non-run playbook actions still error as not-active in passive state', async () => {
      const result = await backend.callTool('playbooks', { action: 'history' }, { rawResult: true });
      expect(result.success).toBe(false);
      expect(result.error).toBe('not_enabled');
      expect(mockBridgeInstance.callTool).not.toHaveBeenCalled();
    });

    it('passive state: `list` answers from the registry, without a bridge', async () => {
      const result = await backend.callTool('playbooks', { action: 'list' });

      expect(result.content[0].text).toContain('flow');
      expect(mockBridgeInstance.callTool).not.toHaveBeenCalled();
      const status = await backend.callTool('status', {}, { rawResult: true });
      expect(status.state).toBe('passive');
    });

    it('passive state: `inspect` answers from the registry, without a bridge', async () => {
      const result = await backend.callTool('playbooks', { action: 'inspect', name: 'flow' });

      expect(result.content[0].text).toContain('flow');
      expect(mockBridgeInstance.callTool).not.toHaveBeenCalled();
      const status = await backend.callTool('status', {}, { rawResult: true });
      expect(status.state).toBe('passive');
    });

    it('passive state: `validate` answers from the registry, without a bridge', async () => {
      const result = await backend.callTool('playbooks', { action: 'validate' });

      expect(result.content[0].text).toContain('✓ flow');
      expect(mockBridgeInstance.callTool).not.toHaveBeenCalled();
      const status = await backend.callTool('status', {}, { rawResult: true });
      expect(status.state).toBe('passive');
    });

    it('passive state: `inspect` on an unknown playbook errors without a bridge', async () => {
      const result = await backend.callTool('playbooks', { action: 'inspect', name: 'ghost' }, { rawResult: false });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ghost');
      expect(mockBridgeInstance.callTool).not.toHaveBeenCalled();
    });

    it('passive state: `run` is NOT implicitly connected — a run owns its own session', async () => {
      const result = await backend.callTool('playbooks', { action: 'run', name: 'flow' }, { rawResult: true });

      expect(result.success).toBe(false);
      expect(result.error).toBe('not_enabled');
      expect(mockBridgeInstance.callTool).not.toHaveBeenCalled();
    });

    it('active state: `list`/`inspect` still route through the bridge as before', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      mockBridgeInstance.callTool.mockClear();
      mockBridgeInstance.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'listed' }] });

      const result = await backend.callTool('playbooks', { action: 'list' });

      expect(mockBridgeInstance.callTool).toHaveBeenCalledWith('playbooks', { action: 'list' }, {});
      expect(result.content[0].text).toBe('listed');
    });

    it('active state: `run` routes through the bridge without a profile-mismatch check', async () => {
      await backend.callTool('connect', { client_id: 'test', profile: 'proj-a' });
      mockBridgeInstance.callTool.mockClear();
      mockBridgeInstance.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ran ok' }] });

      const result = await backend.callTool('playbooks', { action: 'run', name: 'flow', profile: 'proj-b' });

      expect(mockBridgeInstance.callTool).toHaveBeenCalledWith(
        'playbooks', { action: 'run', name: 'flow', profile: 'proj-b' }, {}
      );
      expect(result.content[0].text).toBe('ran ok');
    });
  });

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

    it('shows a warning header, not a green check, when connected with no extension', async () => {
      mockDaemonClientInstance.extensionConnected = false;
      await backend.initialize(makeMockServer(), {});
      const result = await backend.callTool('connect', { client_id: 'test' });

      const text = result.content[0].text;
      expect(text).not.toContain('✅');
      expect(text).toContain('⚠️');
      expect(text).toContain('No extension connected');

      const header = backend.statusHeader();
      expect(header).not.toContain('✅');
      expect(header).toContain('No extension connected');
    });

    it('shows the green check when the daemon reports an extension', async () => {
      mockDaemonClientInstance.extensionConnected = true;
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });

      const header = backend.statusHeader();
      expect(header).toContain('✅');
      expect(header).not.toContain('No extension connected');
    });

    it('flips extensionConnected false when a tool fails with Extension not connected', async () => {
      mockDaemonClientInstance.extensionConnected = true;
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });

      mockBridgeInstance.callTool.mockRejectedValueOnce(new Error('Extension not connected'));
      await expect(backend.callTool('browser_tabs', { action: 'list' })).rejects.toThrow('Extension not connected');

      const header = backend.statusHeader();
      expect(header).toContain('No extension connected');
    });

    it('flips extensionConnected true after a successful bridge tool call', async () => {
      mockDaemonClientInstance.extensionConnected = false;
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });

      mockBridgeInstance.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'tabs' }] });
      await backend.callTool('browser_tabs', { action: 'list' });

      const header = backend.statusHeader();
      expect(header).toContain('✅');
    });

    it('does not flip extensionConnected true on a successful playbooks call (local read, no extension involved)', async () => {
      mockDaemonClientInstance.extensionConnected = false;
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });

      mockBridgeInstance.callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'listed' }] });
      await backend.callTool('playbooks', { action: 'list' });

      expect(backend.extensionConnected).toBe(false);
    });
  });

  // ---- config drift warning (one-shot per session) ----

  describe('statusHeader() — config drift warning', () => {
    afterEach(() => {
      mockDaemonClientInstance.isConfigDrifted.mockReturnValue(false);
    });

    it('omits drift warning when daemon reports no drift', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
      mockDaemonClientInstance.isConfigDrifted.mockReturnValue(false);

      const header = backend.statusHeader();
      expect(header).not.toContain('config.json changed');
    });

    it('surfaces drift warning on first call when daemon reports drift', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
      mockDaemonClientInstance.isConfigDrifted.mockReturnValue(true);

      const header = backend.statusHeader();
      expect(header).toContain('config.json changed');
      expect(header).toContain('npx supersurf-daemon@latest restart');
    });

    it('suppresses drift warning on subsequent calls (one-shot per session)', async () => {
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
      mockDaemonClientInstance.isConfigDrifted.mockReturnValue(true);

      const first = backend.statusHeader();
      const second = backend.statusHeader();
      const third = backend.statusHeader();

      expect(first).toContain('config.json changed');
      expect(second).not.toContain('config.json changed');
      expect(third).not.toContain('config.json changed');
    });

  });

  // ---- statusHeader() — playbook discovery hint ----

  describe('statusHeader() — playbook discovery hint', () => {
    let pbDir: string;
    const metas: Record<string, any> = {};

    beforeEach(async () => {
      pbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-hint-backend-'));
      setPlaybooksDirForTests(pbDir);
      resetRegistryForTests();
      for (const k of Object.keys(metas)) delete metas[k];
      setValidatorForTests(async (f: string) => {
        const name = path.basename(f).replace('.playbook.js', '');
        return {
          file: f, name, hash: `${name}:${JSON.stringify(metas[name])}`, valid: true,
          signature: `${name}()`, validatedAt: 1, meta: metas[name],
        } as any;
      });
      await backend.initialize(makeMockServer(), {});
      await backend.callTool('connect', { client_id: 'test' });
    });

    afterEach(() => {
      setValidatorForTests(null);
      resetRegistryForTests();
      fs.rmSync(pbDir, { recursive: true, force: true });
    });

    /** Write a script and refresh, the way a real tool call would. */
    async function seed(name: string, startingPoint: string) {
      metas[name] = { description: 'p', startingPoint };
      fs.writeFileSync(playbookFile(name), `// ${name}`);
      await refreshRegistry();
    }

    it('renders the hint when the attached tab domain matches a script startingPoint', async () => {
      await seed('gh_login', 'github.com');
      backend.setAttachedTab({ id: 1, index: 0, url: 'https://github.com/settings' });

      const header = backend.statusHeader();
      expect(header).toContain('► 1 playbooks available: gh_login | playbooks "list" for more details');
    });

    it('omits the hint when there is no tab attached', async () => {
      await seed('gh_login', 'github.com');
      expect(backend.statusHeader()).not.toContain('playbooks available');
    });

    it('omits the hint when no script matches the tab domain', async () => {
      await seed('gh_login', 'github.com');
      backend.setAttachedTab({ id: 1, index: 0, url: 'https://example.com/' });
      expect(backend.statusHeader()).not.toContain('playbooks available');
    });

    it('shows the hint once per domain, then suppresses it for the rest of the session', async () => {
      await seed('gh_login', 'github.com');
      backend.setAttachedTab({ id: 1, index: 0, url: 'https://github.com/settings' });

      expect(backend.statusHeader()).toContain('playbooks available');
      expect(backend.statusHeader()).not.toContain('playbooks available');
      expect(backend.statusHeader()).not.toContain('playbooks available');
    });

    it('still hints for a second, different domain after the first was suppressed', async () => {
      await seed('gh_login', 'github.com');
      await seed('example_flow', 'https://example.com/start');

      backend.setAttachedTab({ id: 1, index: 0, url: 'https://github.com/settings' });
      expect(backend.statusHeader()).toContain('gh_login');

      backend.setAttachedTab({ id: 1, index: 0, url: 'https://example.com/other' });
      expect(backend.statusHeader()).toContain('example_flow');
    });

    it('a tool call picks up a script added after the last one — no manual invalidation', async () => {
      backend.setAttachedTab({ id: 1, index: 0, url: 'https://github.com/settings' });
      expect(backend.statusHeader()).not.toContain('playbooks available');

      await seed('gh_login', 'github.com');
      // The old code needed `invalidatePlaybookIndex()` here. `callTool` now
      // refreshes the registry and drops the projection on every call.
      await backend.callTool('status', {}, { rawResult: true });

      expect(backend.statusHeader()).toContain('gh_login');
    });
  });

  describe('statusHeader() — invalid playbook warning', () => {
    let pbDir: string;
    let broken = true;

    beforeEach(async () => {
      pbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-warn-backend-'));
      setPlaybooksDirForTests(pbDir);
      resetRegistryForTests();
      broken = true;
      fs.writeFileSync(playbookFile('bad'), '// bad');
      setValidatorForTests(async (f: string) => ({
        file: f, name: 'bad', hash: broken ? 'h1' : 'h2', valid: !broken,
        error: broken ? 'blocked API: require' : undefined,
        meta: broken ? undefined : { description: 'ok' },
        signature: 'bad()', validatedAt: 1,
      } as any));
      await refreshRegistry();
      await backend.initialize(makeMockServer(), {});
    });

    afterEach(() => {
      setValidatorForTests(null);
      resetRegistryForTests();
      fs.rmSync(pbDir, { recursive: true, force: true });
    });

    it('names the broken script in the passive header, before connect', () => {
      const header = backend.statusHeader();
      expect(header).toContain('bad: blocked API: require');
    });

    it('warns once per name+error, not on every response', () => {
      expect(backend.statusHeader()).toContain('bad: blocked API: require');
      expect(backend.statusHeader()).not.toContain('blocked API: require');
    });

    it('places the warning above the discovery hint', async () => {
      await backend.callTool('connect', { client_id: 'test' });
      fs.writeFileSync(playbookFile('gh_login'), '// gh');
      setValidatorForTests(async (f: string) => {
        const name = path.basename(f).replace('.playbook.js', '');
        return name === 'bad'
          ? { file: f, name, hash: 'h1', valid: false, error: 'blocked API: require', signature: 'bad()', validatedAt: 1 } as any
          : { file: f, name, hash: 'g1', valid: true, signature: 'gh_login()', validatedAt: 1, meta: { description: 'g', startingPoint: 'github.com' } } as any;
      });
      resetRegistryForTests();
      await refreshRegistry();
      backend.setAttachedTab({ id: 1, index: 0, url: 'https://github.com/settings' });

      const header = backend.statusHeader();
      expect(header.indexOf('blocked API: require')).toBeLessThan(header.indexOf('playbooks available'));
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
