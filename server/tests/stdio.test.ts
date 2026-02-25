import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

// Mock the logger
vi.mock('../src/logger', () => ({
  getLogger: () => ({
    log: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  }),
  createLog: () => (..._args: unknown[]) => {},
}));

// Mock ExtensionServer (bridge)
vi.mock('../src/bridge', () => ({
  ExtensionServer: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    notifyClientId: vi.fn(),
    connected: false,
    buildTime: null,
    browser: 'chrome',
    onReconnect: null,
    onTabInfoUpdate: null,
  })),
}));

// Mock experimental registry
vi.mock('../src/experimental/index', () => ({
  experimentRegistry: {
    listAvailable: vi.fn().mockReturnValue(['page_diffing', 'smart_waiting']),
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    getStates: vi.fn().mockReturnValue({ page_diffing: false, smart_waiting: false }),
  },
  isInfraExperimentEnabled: vi.fn().mockReturnValue(false),
  applyInitialState: vi.fn(),
}));

// Mock tools
vi.mock('../src/tools', () => ({
  BrowserBridge: vi.fn(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({ success: true }),
    serverClosed: vi.fn(),
  })),
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
  async function runWithInput(lines: string[]): Promise<string[]> {
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
    });

    for (const line of lines) {
      fakeStdin.push(line + '\n');
    }

    await new Promise((r) => setTimeout(r, 200));

    fakeStdin.push(null);

    await new Promise((r) => setTimeout(r, 100));

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
