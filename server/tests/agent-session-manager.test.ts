/**
 * AgentSessionManager — routing by username, exact error texts, identity
 * decoration. The daemon transport, daemon spawn, BrowserBridge, logger and
 * metrics logger are mocked; AgentSession and the manager are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from 'shared';
import { AgentSessionManager } from '../src/agent-session-manager';
import { experimentRegistry } from '../src/experimental/index';
import type { BackendConfig } from '../src/backend';
import { trailFor } from '../src/playbooks/trail';

// ---- Mocks ----

const behavior = vi.hoisted(() => ({
  connect: 'ok' as 'ok' | 'fail',
  call: 'ok' as 'ok' | 'error' | 'throw',
  callDelayMs: 0,
  initialize: 'ok' as 'ok' | 'throw',
  startDelayMs: 0,
}));
const mocks = vi.hoisted(() => ({ queryDaemonStatus: vi.fn() }));

vi.mock('shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('shared')>();
  return {
    ...actual,
    getLogger: () => ({ log: vi.fn(), enable: vi.fn(), disable: vi.fn() }),
    getRegistry: () => ({
      debugMode: false,
      setSessionLog: vi.fn().mockReturnValue({ logFilePath: '/tmp/test.log', enable: vi.fn(), log: vi.fn() }),
      clearSessionLog: vi.fn(),
      getLogger: vi.fn().mockReturnValue({ log: vi.fn(), enable: vi.fn(), disable: vi.fn() }),
    }),
    createLog: () => (..._args: unknown[]) => {},
    DaemonClient: vi.fn(function (this: any, _sock: string, clientId: string) {
      this.clientId = clientId;
      this.start = vi.fn(async () => {
        if (behavior.startDelayMs) await new Promise(r => setTimeout(r, behavior.startDelayMs));
        if (behavior.connect === 'fail') throw new Error('daemon down');
      });
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
  };
});

vi.mock('../src/daemon-spawn', () => ({
  ensureDaemon: vi.fn().mockResolvedValue(undefined),
  stopDaemon: vi.fn().mockResolvedValue(undefined),
  getSockPath: vi.fn().mockReturnValue('/tmp/test-daemon.sock'),
  queryDaemonStatus: mocks.queryDaemonStatus,
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

// The fake captures the AgentSession passed to initialize() so 'ok' can carry its header.
vi.mock('../src/tools', () => ({
  BrowserBridge: vi.fn(function (this: any) {
    let session: any = null;
    this.initialize = vi.fn(async (_server: any, _ci: any, mgr: any) => {
      if (behavior.initialize === 'throw') throw new Error('bridge init failed');
      session = mgr;
    });
    this.listTools = vi.fn().mockResolvedValue([
      { name: 'browser_navigate', description: 'nav', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
      { name: 'browser_tabs', description: 'tabs', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
    ]);
    this.callTool = vi.fn(async () => {
      if (behavior.callDelayMs) await new Promise(r => setTimeout(r, behavior.callDelayMs));
      if (behavior.call === 'throw') throw new Error('boom');
      if (behavior.call === 'error') return { content: [{ type: 'text', text: 'boom' }], isError: true };
      return { content: [{ type: 'text', text: session.statusHeader() + 'ok' }] };
    });
    this.serverClosed = vi.fn();
    return this;
  }),
}));

// ---- Helpers ----

function makeConfig(fileOverrides: Record<string, unknown> = {}, multiAgent = true): BackendConfig {
  return {
    debug: false,
    port: 5555,
    server: { name: 'supersurf', version: '0.1.0' },
    configService: new ConfigService({
      cli: {},
      env: {},
      file: { logging: { usage_metrics: true }, ...fileOverrides, agents: { multi_agent: multiAgent, ...(fileOverrides.agents as object) } } as any,
    }),
  };
}

const fakeServer = { sendToolsListChanged: vi.fn().mockResolvedValue(undefined) } as any;

async function managerWith(names: string[], fileOverrides: Record<string, unknown> = {}): Promise<AgentSessionManager> {
  const m = new AgentSessionManager(makeConfig(fileOverrides));
  await m.initialize(fakeServer, {});
  for (const username of names) await m.callTool('connect', { username });
  return m;
}

// ---- Tests ----

describe('AgentSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    behavior.connect = 'ok';
    behavior.call = 'ok';
    behavior.callDelayMs = 0;
    behavior.initialize = 'ok';
    behavior.startDelayMs = 0;
    mocks.queryDaemonStatus.mockResolvedValue(null);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('injects a required username into every non-exempt schema', async () => {
    const m = new AgentSessionManager(makeConfig()); await m.initialize(fakeServer, {});
    const tools = await m.listTools();
    const nav = tools.find(t => t.name === 'browser_navigate')!;
    expect(nav.inputSchema.required).toContain('username');
    expect((tools.find(t => t.name === 'status')!.inputSchema.required as string[] | undefined) ?? []).not.toContain('username');
    expect((tools.find(t => t.name === 'profile_list')!.inputSchema.required as string[] | undefined) ?? []).not.toContain('username');
  });

  it('two usernames get two sessions with two daemon ids', async () => {
    const m = await managerWith(['sm-a', 'sm-b']);
    expect(m.get('sm-a')!.clientId).toBe('sm-a');
    expect(m.get('sm-b')!.clientId).toBe('sm-b');
    expect(m.get('sm-a')).not.toBe(m.get('sm-b'));
  });

  it('rejects a duplicate username', async () => {
    const m = await managerWith(['sm-a']);
    const r = await m.callTool('connect', { username: 'sm-a' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Username "sm-a" is already in use by a live agent.');
  });

  it('does not keep a name whose connect failed', async () => {
    behavior.connect = 'fail';
    const m = new AgentSessionManager(makeConfig()); await m.initialize(fakeServer, {});
    await m.callTool('connect', { username: 'sm-a' });
    expect(m.get('sm-a')).toBeUndefined();
  });

  it('concurrent connects for one name: exactly one wins, the other is rejected as in use', async () => {
    behavior.startDelayMs = 20;
    const m = new AgentSessionManager(makeConfig()); await m.initialize(fakeServer, {});
    const [r1, r2] = await Promise.all([
      m.callTool('connect', { username: 'sm-a' }),
      m.callTool('connect', { username: 'sm-a' }),
    ]);
    const texts = [r1, r2].map(r => r.content[0].text as string);
    const rejected = texts.filter(t => t.includes('Username "sm-a" is already in use by a live agent. Pick another username and call `connect` again.'));
    expect(rejected).toHaveLength(1);
    expect(texts.filter(t => t.includes('Connected to Service'))).toHaveLength(1);
    expect(m.get('sm-a')).toBeDefined();
  });

  it('a connect that fails after the experiment bind releases that id\'s per-session state', async () => {
    experimentRegistry.enable('sm-a', 'page_diffing');
    expect(experimentRegistry.isEnabled('page_diffing', 'sm-a')).toBe(true);
    behavior.initialize = 'throw';
    const m = new AgentSessionManager(makeConfig()); await m.initialize(fakeServer, {});
    const r = await m.callTool('connect', { username: 'sm-a' });
    expect(r.isError).toBe(true);
    expect(m.get('sm-a')).toBeUndefined();
    expect(experimentRegistry.isEnabled('page_diffing', 'sm-a')).toBe(false);
  });

  it('missing username: exact text, with the connect-first hint when nobody is live', async () => {
    const m = new AgentSessionManager(makeConfig()); await m.initialize(fakeServer, {});
    const r = await m.callTool('browser_navigate', { url: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('username required — your username is in the status line of your earlier SuperSurf results.');
    expect(r.content[0].text).toContain('call `connect` with your own username first');
  });

  it('missing username with a live session: no connect-first hint', async () => {
    const m = await managerWith(['sm-a']);
    const r = await m.callTool('browser_navigate', { url: 'x' });
    expect(r.content[0].text).toContain('username required');
    expect(r.content[0].text).not.toContain('call `connect` with your own username first');
  });

  it('unknown username: exact text with the idle minutes', async () => {
    const m = await managerWith(['sm-a']);
    const r = await m.callTool('browser_navigate', { username: 'nope', url: 'x' });
    expect(r.content[0].text).toBe('No live session for username "nope". Check the status line of your earlier SuperSurf results for your exact username. If it expired after 10 min idle, its tabs are closed — call `connect` to start again.');
  });

  it('success and error results carry the caller\'s identity', async () => {
    const m = await managerWith(['sm-a']);
    behavior.call = 'ok';    expect((await m.callTool('browser_tabs', { username: 'sm-a', action: 'list' })).content[0].text).toContain('👤 you are sm-a');
    behavior.call = 'error'; expect((await m.callTool('browser_tabs', { username: 'sm-a', action: 'list' })).content[0].text).toContain('👤 you are sm-a');
    behavior.call = 'throw';
    const r = await m.callTool('browser_tabs', { username: 'sm-a', action: 'list' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('👤 you are sm-a');
    expect(r.content[0].text).toContain('boom');
  });

  it('raw mode rethrows and is not decorated', async () => {
    const m = await managerWith(['sm-a']);
    behavior.call = 'throw';
    await expect(m.callTool('browser_tabs', { username: 'sm-a', action: 'list' }, { rawResult: true })).rejects.toThrow('boom');
  });

  it('strips username before the session sees the args', async () => {
    const m = await managerWith(['sm-a']);
    const spy = vi.spyOn(m.get('sm-a')!, 'callTool');
    await m.callTool('browser_tabs', { username: 'sm-a', action: 'list' });
    expect(spy).toHaveBeenCalledWith('browser_tabs', { action: 'list' }, {});
  });

  it('disconnect removes the name', async () => {
    const m = await managerWith(['sm-a']);
    await m.callTool('disconnect', { username: 'sm-a' });
    expect(m.get('sm-a')).toBeUndefined();
  });

  it('status without username reports health and names nobody', async () => {
    mocks.queryDaemonStatus.mockResolvedValue({ version: '9.9.9', uptimeSeconds: 61, extensionConnected: true, extensionBrowser: 'Chromium', sessions: [{ sessionId: 'sm-a' }, { sessionId: 'sm-b' }] });
    const m = await managerWith(['sm-a', 'sm-b']);
    const text = (await m.callTool('status', {})).content[0].text;
    expect(text).toMatch(/^SuperSurf v/);
    expect(text).not.toMatch(/sm-a|sm-b|2 agents|sessions/);
    const raw = await m.callTool('status', {}, { rawResult: true });
    expect(raw).toEqual({ server_version: expect.any(String), daemon: { running: true, version: '9.9.9', uptime_seconds: 61, extension_connected: true, browser: 'Chromium' } });
  });

  it('status with a live username returns that session\'s status', async () => {
    const m = await managerWith(['sm-a']);
    expect((await m.callTool('status', { username: 'sm-a' })).content[0].text).toContain('👤 you are sm-a');
  });

  it('status with an unknown username returns health plus the unknown-username hint', async () => {
    mocks.queryDaemonStatus.mockResolvedValue({ version: '9.9.9', uptimeSeconds: 61, extensionConnected: true, extensionBrowser: 'Chromium' });
    const m = await managerWith(['sm-a']);
    const raw = await m.callTool('status', { username: 'ghost' }, { rawResult: true });
    expect(raw.warning).toMatch(/No live session for username "ghost"/);
    expect(raw.daemon.running).toBe(true);
    const text = (await m.callTool('status', { username: 'ghost' })).content[0].text as string;
    expect(text).toMatch(/^SuperSurf v/);
    expect(text).toContain('No live session for username "ghost"');
    expect(text).not.toContain('sm-a');
  });

  it('status lists an optional username property', async () => {
    const m = new AgentSessionManager(makeConfig()); await m.initialize(fakeServer, {});
    const status = (await m.listTools()).find(t => t.name === 'status')!;
    expect((status.inputSchema.properties as Record<string, unknown>).username).toBeDefined();
    expect((status.inputSchema.required as string[] | undefined) ?? []).not.toContain('username');
  });

  it('a fresh connect starts with an empty action trail', async () => {
    const m = await managerWith(['x']);
    await m.callTool('disconnect', { username: 'x' });
    // an in-flight call finishing after disconnect recreates the trail
    trailFor('x').record({ tool: 'browser_tabs', type: 'browser_tabs', outcome: 'ok', message: 'late', params: {} } as any);
    await m.callTool('connect', { username: 'x' });
    expect(trailFor('x').tail(10).total).toBe(0);
  });

  describe('idle expiry', () => {
    const idle = { agents: { idle_timeout_ms: 1000 } };

    it('expires an idle username and disconnects its session', async () => {
      vi.useFakeTimers();
      const m = await managerWith(['sm-a'], idle);
      const s = m.get('sm-a')!; const spy = vi.spyOn(s, 'callTool');
      await vi.advanceTimersByTimeAsync(1001);
      expect(m.get('sm-a')).toBeUndefined();
      expect(spy).toHaveBeenCalledWith('disconnect', {}, { rawResult: true });
      expect((await m.callTool('browser_tabs', { username: 'sm-a', action: 'list' })).content[0].text).toContain('If it expired after');
    });

    it('an idle_timeout_ms above the setTimeout limit does not expire at once', async () => {
      vi.useFakeTimers();
      const m = await managerWith(['sm-a'], { agents: { idle_timeout_ms: 1e10 } });
      await vi.advanceTimersByTimeAsync(1001);
      expect(m.get('sm-a')).toBeDefined();
    });

    it('a call resets the clock', async () => {
      vi.useFakeTimers();
      const m = await managerWith(['sm-a'], idle);
      await vi.advanceTimersByTimeAsync(800);
      await m.callTool('browser_tabs', { username: 'sm-a', action: 'list' });
      await vi.advanceTimersByTimeAsync(800);
      expect(m.get('sm-a')).toBeDefined();
    });

    it('a long call is not expired under itself', async () => {
      vi.useFakeTimers();
      const m = await managerWith(['sm-a'], idle);
      behavior.callDelayMs = 5000;
      const p = m.callTool('browser_tabs', { username: 'sm-a', action: 'list' });
      await vi.advanceTimersByTimeAsync(5000); await p;
      expect(m.get('sm-a')).toBeDefined();
    });

    it('an old session\'s late call does not decrement the new session\'s busy count', async () => {
      vi.useFakeTimers();
      const m = await managerWith(['sm-a'], idle);
      behavior.callDelayMs = 1500;
      const pX = m.callTool('browser_tabs', { username: 'sm-a', action: 'list' });
      await m.callTool('disconnect', { username: 'sm-a' });
      await m.callTool('connect', { username: 'sm-a' });
      behavior.callDelayMs = 5000;
      const pY = m.callTool('browser_tabs', { username: 'sm-a', action: 'list' });
      await vi.advanceTimersByTimeAsync(2500); // X resolved at 1500; Y still in flight
      await pX;
      expect(m.get('sm-a')).toBeDefined();
      await vi.advanceTimersByTimeAsync(2500); await pY;
      expect(m.get('sm-a')).toBeDefined();
    });

    it('a failed disconnect keeps the name routable', async () => {
      const m = await managerWith(['sm-a']);
      const s = m.get('sm-a')!;
      vi.spyOn(s, 'callTool').mockRejectedValue(new Error('daemon hung up'));
      const r = await m.callTool('disconnect', { username: 'sm-a' });
      expect(r.isError).toBe(true);
      expect(s.state).not.toBe('passive');
      expect(m.get('sm-a')).toBe(s);
    });

    it('status with a live username resets the idle clock', async () => {
      vi.useFakeTimers();
      const m = await managerWith(['sm-a'], idle);
      await vi.advanceTimersByTimeAsync(800);
      await m.callTool('status', { username: 'sm-a' });
      await vi.advanceTimersByTimeAsync(800); // past the original deadline, under one timeout from status
      expect(m.get('sm-a')).toBeDefined();
    });

    it('disconnect leaves no timer and no second disconnect', async () => {
      vi.useFakeTimers();
      const m = await managerWith(['sm-a'], idle);
      const spy = vi.spyOn(m.get('sm-a')!, 'callTool');
      expect(vi.getTimerCount()).toBe(1);
      await m.callTool('disconnect', { username: 'sm-a' });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(spy.mock.calls.filter(c => c[0] === 'disconnect')).toHaveLength(1);
    });

    it('releases the name even when the expiry disconnect throws', async () => {
      vi.useFakeTimers();
      const m = await managerWith(['sm-a'], idle);
      vi.spyOn(m.get('sm-a')!, 'callTool').mockRejectedValue(new Error('gone'));
      await vi.advanceTimersByTimeAsync(1001);
      expect(m.get('sm-a')).toBeUndefined();
    });
  });

  // 4.0.0 connection semantics: agents.multi_agent off (the default).
  describe('default mode (agents.multi_agent off)', () => {
    const V4_CONNECT_SCHEMA = {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Human-readable identifier for this MCP client (e.g., "my-project").' },
        profile: { type: 'string', description: 'Profile name for isolated Chromium instance, or omit for unmanaged connection to user\'s own browser.' },
      },
      required: ['client_id'],
    };
    const MISSING_TEXT = "### Missing Required Parameter\n\n`client_id` is required.\n\n**Example:**\n```\nconnect client_id='my-project'\n```";

    async function plain(idle: Record<string, unknown> = {}): Promise<AgentSessionManager> {
      const m = new AgentSessionManager(makeConfig(idle, false));
      await m.initialize(fakeServer, {});
      return m;
    }

    it('lists no username property on any tool; connect and status match 4.0.0', async () => {
      const tools = await (await plain()).listTools();
      for (const t of tools) {
        expect(Object.keys((t.inputSchema.properties as object) ?? {}), t.name).not.toContain('username');
        expect((t.inputSchema.required as string[] | undefined) ?? [], t.name).not.toContain('username');
      }
      expect(tools.find(t => t.name === 'connect')!.inputSchema).toEqual(V4_CONNECT_SCHEMA);
      expect(tools.find(t => t.name === 'connect')!.description).toBe(
        'Connect to the SuperSurf service and start browser automation. Pass a client_id to identify this session. Read the skill guide for best practices: https://liquidbuiltit.github.io/Supersurf/skill.md');
      const status = tools.find(t => t.name === 'status')!;
      expect(status.inputSchema).toEqual({ type: 'object', properties: {}, required: [] });
      expect(status.description).toBe('Show current connection state: passive (idle), active (server up), or connected (extension linked).');
    });

    it('client_id connects one session; every later call routes to it without a name', async () => {
      const m = await plain();
      const r = await m.callTool('connect', { client_id: 'my-project' }, { rawResult: true });
      expect(r).toMatchObject({ success: true, client_id: 'my-project' });
      expect(r.username).toBeUndefined();
      const nav = await m.callTool('browser_navigate', { url: 'https://example.com' });
      expect(nav.isError).toBeUndefined();
      expect(nav.content[0].text).not.toContain('👤');
      expect((await m.callTool('profile_list', {})).isError).toBeUndefined();
      expect((await m.callTool('disconnect', {})).content[0].text).toContain('Disconnected');
    });

    it('nameless status reports the one session, before and after connect, with no identity line', async () => {
      const m = await plain();
      const before = await m.callTool('status', {}, { rawResult: true });
      expect(before).toMatchObject({ state: 'passive', client_id: null });
      await m.callTool('connect', { client_id: 'my-project' });
      const after = await m.callTool('status', {}, { rawResult: true });
      expect(after).toMatchObject({ state: 'active', client_id: 'my-project' });
      const text = (await m.callTool('status', {})).content[0].text as string;
      expect(text).not.toContain('👤');
      expect(text).not.toMatch(/missing|unknown|No live session/i);
    });

    it('no username decoration anywhere, including the status header', async () => {
      const m = await plain();
      expect((await m.callTool('connect', { client_id: 'my-project' })).content[0].text).not.toContain('👤');
      const err = (behavior.call = 'error', await m.callTool('browser_tabs', { action: 'list' }));
      expect(err.content[0].text).not.toContain('👤');
    });

    it('missing, blank, or username-only connect: 4.0.0 text and missing_client_id code', async () => {
      const m = await plain();
      for (const args of [{}, { client_id: '   ' }, { username: 'sneaky' }]) {
        const r = await m.callTool('connect', args);
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toBe(MISSING_TEXT);
        expect(await m.callTool('connect', args, { rawResult: true }))
          .toEqual({ success: false, error: 'missing_client_id', message: 'client_id is required' });
      }
    });

    it('a malformed client_id is refused in client_id words', async () => {
      const m = await plain();
      const raw = await m.callTool('connect', { client_id: '../etc' }, { rawResult: true });
      expect(raw).toMatchObject({ success: false, error: 'invalid_client_id' });
      expect(raw.message).toContain('`client_id`');
      expect(raw.message).not.toContain('username');
      const mcp = await m.callTool('connect', { client_id: 'a b' });
      expect(mcp.content[0].text).toContain('Invalid client_id');
    });

    it('connecting twice says Already Connected with a Client ID', async () => {
      const m = await plain();
      await m.callTool('connect', { client_id: 'my-project' });
      expect((await m.callTool('connect', { client_id: 'other' })).content[0].text).toContain('**Client ID:** my-project');
      expect(await m.callTool('connect', { client_id: 'other' }, { rawResult: true }))
        .toMatchObject({ already_connected: true, client_id: 'my-project' });
    });

    it('disconnect then reconnect works on the same process', async () => {
      const m = await plain();
      await m.callTool('connect', { client_id: 'one' });
      await m.callTool('disconnect', {});
      expect(await m.callTool('status', {}, { rawResult: true })).toMatchObject({ state: 'passive' });
      expect(await m.callTool('connect', { client_id: 'two' }, { rawResult: true })).toMatchObject({ success: true, client_id: 'two' });
    });

    it('a fresh connect starts with an empty action trail', async () => {
      const m = await plain();
      await m.callTool('connect', { client_id: 'x' });
      await m.callTool('disconnect', {});
      trailFor('x').record({ tool: 'browser_tabs', type: 'browser_tabs', outcome: 'ok', message: 'late', params: {} } as any);
      await m.callTool('connect', { client_id: 'x' });
      expect(trailFor('x').tail(10).total).toBe(0);
    });

    it('a repeat connect while connected keeps the live action trail', async () => {
      const m = await plain();
      await m.callTool('connect', { client_id: 'y' });
      trailFor('y').record({ tool: 'browser_tabs', type: 'browser_tabs', outcome: 'ok', message: 'live', params: {} } as any);
      await m.callTool('connect', { client_id: 'y' });
      expect(trailFor('y').tail(10).total).toBe(1);
    });

    it('never idle-expires the session', async () => {
      vi.useFakeTimers();
      const m = await plain({ agents: { idle_timeout_ms: 1000 } });
      await m.callTool('connect', { client_id: 'my-project' });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await m.callTool('status', {}, { rawResult: true })).toMatchObject({ state: 'active' });
    });
  });
});
