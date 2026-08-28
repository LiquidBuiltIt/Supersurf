/**
 * Cross-manager isolation lock.
 *
 * Two ConnectionManager instances in one Node process must not share
 * session-scoped state. Disconnecting one must leave the other's experiment
 * flags, humanized cursor state, bridge and metrics logger untouched.
 *
 * The daemon transport, daemon spawn, BrowserBridge, logger and metrics
 * logger are mocked. The experiment registry and the mouse-humanization
 * module are deliberately NOT mocked — they are what is under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager, BackendConfig } from '../src/backend';
import { ConfigService } from 'shared';
import { experimentRegistry } from '../src/experimental/index';
import { initSession, getSession, destroySession } from '../src/experimental/mouse-humanization/index';

// ---- Mocks ----

const clearSessionLog = vi.fn();
vi.mock('../src/logger', () => ({
  getLogger: () => ({ log: vi.fn(), enable: vi.fn(), disable: vi.fn() }),
  getRegistry: () => ({
    debugMode: false,
    setSessionLog: vi.fn().mockReturnValue({ logFilePath: '/tmp/test.log', enable: vi.fn(), log: vi.fn() }),
    clearSessionLog,
    getLogger: vi.fn().mockReturnValue({ log: vi.fn(), enable: vi.fn(), disable: vi.fn() }),
  }),
  createLog: () => (..._args: unknown[]) => {},
}));

const { clearTipCounters } = vi.hoisted(() => ({ clearTipCounters: vi.fn() }));
vi.mock('../src/tips', async () => {
  const actual = await vi.importActual<typeof import('../src/tips')>('../src/tips');
  return { ...actual, clearTipCounters };
});

// A fresh transport object per construction, so bind() keying is observable.
vi.mock('../src/daemon-client', () => ({
  DaemonClient: vi.fn(function (this: any, _sock: string, clientId: string) {
    this.clientId = clientId;
    this.start = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.notifyClientId = vi.fn();
    this.sendCmd = vi.fn().mockResolvedValue({});
    this.connected = true;
    this.browser = 'chrome';
    this.buildTime = null;
    this.version = '0.1.0';
    this.extensionConnected = true;
    this.onReconnect = null;
    this.onTabInfoUpdate = null;
    this.isConfigDrifted = vi.fn(() => false);
    return this;
  }),
}));

vi.mock('../src/daemon-spawn', () => ({
  ensureDaemon: vi.fn().mockResolvedValue(undefined),
  stopDaemon: vi.fn().mockResolvedValue(undefined),
  getSockPath: vi.fn().mockReturnValue('/tmp/test-daemon.sock'),
}));

vi.mock('../src/usage-metrics-logger', () => ({
  UsageMetricsLogger: vi.fn(function (this: any) {
    this.filePath = '/tmp/metrics.ndjson';
    this.write = vi.fn();
    this.getPath = vi.fn().mockReturnValue('/tmp/metrics.ndjson');
    return this;
  }),
  redactParams: vi.fn((p: any) => p),
}));

// A fresh bridge object per construction, so per-manager instancing is observable.
vi.mock('../src/tools', () => ({
  BrowserBridge: vi.fn(function (this: any) {
    this.initialize = vi.fn().mockResolvedValue(undefined);
    this.listTools = vi.fn().mockResolvedValue([]);
    this.callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    this.serverClosed = vi.fn();
    return this;
  }),
}));

// ---- Helpers ----

function makeConfig(): BackendConfig {
  return {
    debug: false,
    port: 5555,
    server: { name: 'supersurf', version: '0.1.0' },
    configService: new ConfigService({
      cli: {},
      env: {},
      file: { logging: { usage_metrics: true } },
    }),
  };
}

function makeMockServer() {
  return { sendToolsListChanged: vi.fn().mockResolvedValue(undefined) } as any;
}

async function connectManager(clientId: string): Promise<ConnectionManager> {
  const mgr = new ConnectionManager(makeConfig());
  await mgr.initialize(makeMockServer(), {});
  const res = await mgr.callTool('connect', { client_id: clientId }, { rawResult: true });
  expect(res.success).toBe(true);
  return mgr;
}

// ---- Tests ----

describe('two ConnectionManagers in one process', () => {
  let a: ConnectionManager;
  let b: ConnectionManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    experimentRegistry.reset();
    destroySession('session-a');
    destroySession('session-b');
    a = await connectManager('session-a');
    b = await connectManager('session-b');
  });

  afterEach(() => {
    experimentRegistry.reset();
    destroySession('session-a');
    destroySession('session-b');
  });

  it('disconnecting one leaves the other experiment flags intact', async () => {
    experimentRegistry.enable('session-a', 'page_diffing');
    experimentRegistry.enable('session-b', 'smart_waiting');

    await b.callTool('disconnect', {}, { rawResult: true });

    expect(experimentRegistry.isEnabled('page_diffing', 'session-a')).toBe(true);
    expect(experimentRegistry.isEnabled('smart_waiting', 'session-b')).toBe(false);
  });

  it('disconnecting one leaves the other humanization session intact', async () => {
    initSession('session-a');
    initSession('session-b');

    await b.callTool('disconnect', {}, { rawResult: true });

    expect(getSession('session-a')).toBeDefined();
    expect(getSession('session-b')).toBeUndefined();
  });

  it('each manager binds its own daemon transport', async () => {
    experimentRegistry.bind('session-a', (a as any).extensionServer);
    experimentRegistry.bind('session-b', (b as any).extensionServer);

    await experimentRegistry.toggle('session-a', 'page_diffing', true);

    expect((a as any).extensionServer.sendCmd).toHaveBeenCalledWith(
      'experiments.toggle',
      { experiment: 'page_diffing', enabled: true },
      5000,
    );
    expect((b as any).extensionServer.sendCmd).not.toHaveBeenCalledWith(
      'experiments.toggle',
      { experiment: 'page_diffing', enabled: true },
      5000,
    );
  });

  it('the surviving manager stays active after the other disconnects', async () => {
    await b.callTool('disconnect', {}, { rawResult: true });

    const statusA = await a.callTool('status', {}, { rawResult: true });
    const statusB = await b.callTool('status', {}, { rawResult: true });

    expect(statusA.state).toBe('active');
    expect(statusA.client_id).toBe('session-a');
    expect(statusB.state).toBe('passive');
  });

  // ---- Already-safe locks (spec §8: "do not touch") ----

  it('session log and tip counters are cleared for the disconnecting session only', async () => {
    clearSessionLog.mockClear();
    clearTipCounters.mockClear();

    await b.callTool('disconnect', {}, { rawResult: true });

    expect(clearSessionLog).toHaveBeenCalledWith('session-b');
    expect(clearSessionLog).not.toHaveBeenCalledWith('session-a');
    expect(clearTipCounters).toHaveBeenCalledWith('session-b');
    expect(clearTipCounters).not.toHaveBeenCalledWith('session-a');
  });

  it('each manager owns a distinct BrowserBridge and metrics logger', () => {
    expect((a as any).bridge).toBeTruthy();
    expect((b as any).bridge).toBeTruthy();
    expect((a as any).bridge).not.toBe((b as any).bridge);
    expect((a as any).metricsLogger).not.toBe((b as any).metricsLogger);
  });
});
