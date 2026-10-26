import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import { ConfigService } from 'shared';

// Mock the logger and DaemonClient (replaces ExtensionServer)
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
    DaemonClient: vi.fn(function (this: any) {
      Object.assign(this, {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        notifyClientId: vi.fn(),
        sendCmd: vi.fn().mockResolvedValue(undefined),
        connected: true,
        buildTime: null,
        browser: 'chrome',
        version: '0.1.0',
        extensionConnected: true,
        isConfigDrifted: vi.fn(() => false),
        onReconnect: null,
        onTabInfoUpdate: null,
      });
    }),
  };
});

// Mock daemon-spawn
vi.mock('../src/daemon-spawn', () => ({
  ensureDaemon: vi.fn().mockResolvedValue(undefined),
  stopDaemon: vi.fn().mockResolvedValue(undefined),
  getSockPath: vi.fn().mockReturnValue('/tmp/test-daemon.sock'),
  queryDaemonStatus: vi.fn().mockResolvedValue(null),
}));

// Mock experimental registry
vi.mock('../src/experimental/index', () => ({
  experimentRegistry: {
    listAvailable: vi.fn().mockReturnValue(['page_diffing', 'smart_waiting']),
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    getStates: vi.fn().mockReturnValue({ page_diffing: false, smart_waiting: false }),
    bind: vi.fn(),
    unbind: vi.fn(),
    isEnabled: vi.fn().mockReturnValue(false),
  },
  applyInitialState: vi.fn(),
}));

// Mock tools
const bridgeCall = vi.hoisted(() => vi.fn());
vi.mock('../src/tools', () => ({
  BrowserBridge: vi.fn(function (this: any) {
    this.initialize = vi.fn().mockResolvedValue(undefined);
    this.listTools = vi.fn().mockResolvedValue([]);
    this.callTool = bridgeCall.mockResolvedValue({ success: true, from: 'session' });
    this.serverClosed = vi.fn();
  }),
}));

/**
 * Since startScriptMode sets up readline on process.stdin and writes to stdout,
 * we test it by injecting lines and capturing output.
 */
describe('stdio (script mode)', () => {
  let originalStdin: typeof process.stdin;
  let fakeStdin: Readable;
  let capturedOutput: string[];
  let originalConsoleLog: typeof console.log;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedOutput = [];
    originalConsoleLog = console.log;
    console.log = vi.fn((...args: any[]) => {
      capturedOutput.push(args.map(String).join(' '));
    });

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  /**
   * Helper to start script mode with a fake stdin and push lines into it.
   */
  async function runWithInput(lines: string[], sequential = false, multiAgent = false): Promise<string[]> {
    fakeStdin = new Readable({
      read() {},
    });

    originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    const { startScriptMode } = await import('../src/stdio');

    const startPromise = startScriptMode({
      debug: false,
      port: 5555,
      server: { name: 'supersurf', version: '0.1.0' },
      configService: new ConfigService({ cli: {}, env: {}, file: { agents: { multi_agent: multiAgent } } as any }),
    });

    // Every non-blank input line yields exactly one output line (a batch yields one array line).
    const waitForOutputs = (n: number) => vi.waitFor(() => expect(capturedOutput.length).toBeGreaterThanOrEqual(n), { timeout: 5000, interval: 10 });
    let expected = 0;
    for (const line of lines) {
      fakeStdin.push(line + '\n');
      if (line.trim()) expected++;
      if (sequential) await waitForOutputs(expected);
    }

    await waitForOutputs(expected);

    fakeStdin.push(null);

    // readline 'close' -> serverClosed() -> process.exit(0) (mocked)
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled(), { timeout: 5000, interval: 10 });

    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });

    return capturedOutput;
  }

  it('valid JSON-RPC 2.0 request gets routed to backend.callTool', async () => {
    const output = await runWithInput([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: {} }),
    ]);

    expect(output.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(1);
    expect(parsed.result).toBeDefined();
  });

  it('connect then a call with username reaches that agent\'s session', async () => {
    const output = await runWithInput([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'connect', params: { username: 'script-a' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'browser_tabs', params: { username: 'script-a', action: 'list' } }),
    ], true, true);

    const routed = output.map((o) => JSON.parse(o)).find((o) => o.id === 2);
    expect(routed.result).toEqual({ success: true, from: 'session' });
    expect(bridgeCall).toHaveBeenCalledWith('browser_tabs', { action: 'list' }, expect.anything());
  });

  it('default mode: connect with client_id, then calls need no name', async () => {
    const output = await runWithInput([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'connect', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'connect', params: { client_id: 'script-a' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'browser_tabs', params: { action: 'list' } }),
    ], true);

    const byId = (id: number) => output.map((o) => JSON.parse(o)).find((o) => o.id === id);
    expect(byId(1).result).toMatchObject({ success: false, error: 'missing_client_id' });
    expect(byId(2).result).toMatchObject({ success: true, client_id: 'script-a' });
    expect(byId(3).result).toEqual({ success: true, from: 'session' });
    expect(bridgeCall).toHaveBeenCalledWith('browser_tabs', { action: 'list' }, expect.anything());
  });

  it('invalid jsonrpc version returns error code -32600', async () => {
    const output = await runWithInput([
      JSON.stringify({ jsonrpc: '1.0', id: 2, method: 'status' }),
    ]);

    expect(output.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.error.code).toBe(-32600);
    expect(parsed.error.message).toContain('2.0');
  });

  it('missing method returns error code -32600', async () => {
    const output = await runWithInput([JSON.stringify({ jsonrpc: '2.0', id: 3 })]);

    expect(output.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.error.code).toBe(-32600);
    expect(parsed.error.message).toContain('method');
  });

  it('parse errors return -32700', async () => {
    const output = await runWithInput(['not valid json {{{{']);

    expect(output.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(output[0]);
    expect(parsed.error.code).toBe(-32700);
    expect(parsed.error.message).toContain('Parse error');
  });

  it('batch requests (arrays) are processed', async () => {
    const batch = [
      { jsonrpc: '2.0', id: 10, method: 'status', params: {} },
      { jsonrpc: '2.0', id: 11, method: 'status', params: {} },
    ];
    const output = await runWithInput([JSON.stringify(batch)]);

    expect(output.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(output[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe(10);
    expect(parsed[1].id).toBe(11);
  });

  it('empty lines are ignored', async () => {
    const output = await runWithInput(['', '   ', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status' })]);

    const validOutputs = output.filter((o) => {
      try {
        JSON.parse(o);
        return true;
      } catch {
        return false;
      }
    });
    expect(validOutputs.length).toBe(1);
  });
});
