/**
 * E9 resume: after a daemon hand-off the worker's AgentSessionManager rebuilds each shim
 * agent session as `active`, with no `connect` call. The fake host stands in for the daemon
 * link; AgentSession and the manager are real; BrowserBridge is a fake that talks to the link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from 'shared';
import { createFakeHost, fakeLink } from './helpers/fake-host';
import { AgentSessionManager } from '../src/agent-session-manager';
import { AgentSession } from '../src/backend';
import { defaultBackend } from '../src/playbooks/runner';
import { experimentRegistry } from '../src/experimental/index';
import { getSession } from '../src/experimental/mouse-humanization/index';
import type { BackendConfig } from '../src/backend';

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
  };
});

vi.mock('../src/usage-metrics-logger', () => ({
  UsageMetricsLogger: vi.fn(function (this: any) {
    this.write = vi.fn();
    return this;
  }),
  redactParams: vi.fn((p: any) => p),
}));

// The fake bridge sends one command over the session's link, so a test can see where a call goes.
vi.mock('../src/tools', () => ({
  BrowserBridge: vi.fn(function (this: any, _cfg: any, ext: any) {
    this.initialize = vi.fn(async () => {});
    this.listTools = vi.fn().mockResolvedValue([]);
    this.callTool = vi.fn(async () => {
      await ext.sendCmd('probe', {});
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    this.serverClosed = vi.fn();
    return this;
  }),
}));

const fakeServer = { sendToolListChanged: vi.fn().mockResolvedValue(undefined) } as any;

function makeConfig(multiAgent: boolean, idleMs?: number): BackendConfig {
  return {
    debug: false,
    port: 5555,
    server: { name: 'supersurf', version: '0.1.0' },
    configService: new ConfigService({
      cli: {},
      env: {},
      file: { agents: { multi_agent: multiAgent, ...(idleMs ? { idle_timeout_ms: idleMs } : {}) } } as any,
    }),
  };
}

const entry = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, profileId: null, attachedTabId: null, experiments: {}, ...over }) as any;

/** A host whose links claim a parked session unless a test says otherwise. */
function resumingHost(over: Record<string, unknown> = {}) {
  const links: any[] = [];
  const host = createFakeHost({
    openLink: vi.fn(async (opts: any) => {
      const link = fakeLink({ resumed: true, attachedTabId: null, profileId: null, ...over });
      (link as any).opts = opts;
      links.push(link);
      return link;
    }),
  });
  return { host, links };
}

async function managerFor(multi: boolean, host = resumingHost().host, idleMs?: number) {
  const m = new AgentSessionManager(makeConfig(multi, idleMs), host);
  await m.initialize(fakeServer, {});
  return m;
}

const sentMethods = (link: any) => (link.sendCmd as any).mock.calls.map((c: any[]) => c[0]);

describe('AgentSessionManager.resume', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); experimentRegistry.reset(); });

  it('default mode: the lobby comes back active with the same clientId and no profiles.connect', async () => {
    const { host, links } = resumingHost();
    const m = await managerFor(false, host);
    await m.resume([entry('my-project')]);
    const lobby = (m as any)._lobby as AgentSession;
    expect(lobby.state).toBe('active');
    expect(lobby.clientId).toBe('my-project');
    expect(host.openLink).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'my-project', resumable: true, resume: true }));
    expect(sentMethods(links[0])).not.toContain('profiles.connect');
  });

  it('a tool call after resume reaches the link with no connect', async () => {
    const { host, links } = resumingHost();
    const m = await managerFor(false, host);
    await m.resume([entry('my-project')]);
    const r = await m.callTool('browser_navigate', { url: 'https://example.com' });
    expect(r.isError).not.toBe(true);
    expect(sentMethods(links[0])).toContain('probe');
    expect(host.openLink).toHaveBeenCalledTimes(1); // the resume link only, no connect
  });

  it('default mode uses the first entry only', async () => {
    const { host } = resumingHost();
    const m = await managerFor(false, host);
    await m.resume([entry('first'), entry('second')]);
    expect(host.openLink).toHaveBeenCalledTimes(1);
    expect((m as any)._lobby.clientId).toBe('first');
  });

  it('a bound profile is restored without profiles.connect', async () => {
    const { host, links } = resumingHost({ profileId: 'work' });
    const m = await managerFor(false, host);
    await m.resume([entry('my-project', { profileId: 'work' })]);
    expect((m as any)._lobby.profile).toBe('work');
    expect(sentMethods(links[0])).not.toContain('profiles.connect');
  });

  it('extensionConnected comes from the ack', async () => {
    const { host } = resumingHost({ extensionConnected: false });
    const m = await managerFor(false, host);
    await m.resume([entry('my-project')]);
    expect((m as any)._lobby.extensionConnected).toBe(false);
  });

  it('multi mode: each name is stored, active, and arms idle expiry', async () => {
    vi.useFakeTimers();
    const { host, links } = resumingHost();
    const m = await managerFor(true, host, 1000);
    await m.resume([entry('agent-a'), entry('agent-b')]);
    expect(m.get('agent-a')!.state).toBe('active');
    expect(m.get('agent-b')!.clientId).toBe('agent-b');
    expect(links).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1100);
    expect(m.get('agent-a')).toBeUndefined();
    expect(m.get('agent-b')).toBeUndefined();
    expect(links[0].stop).toHaveBeenCalled();
  });

  it('a non-resumed ack leaves the session passive and closes the link', async () => {
    const { host, links } = resumingHost({ resumed: false });
    const m = await managerFor(false, host);
    await m.resume([entry('my-project')]);
    expect((m as any)._lobby.state).toBe('passive');
    expect(links[0].stop).toHaveBeenCalled();
  });

  it('multi mode: a non-resumed ack stores nothing', async () => {
    const { host } = resumingHost({ resumed: false });
    const m = await managerFor(true, host);
    await m.resume([entry('agent-a')]);
    expect(m.get('agent-a')).toBeUndefined();
  });

  it('never throws when the link fails to open', async () => {
    const host = createFakeHost({ openLink: vi.fn(async () => { throw new Error('daemon gone'); }) });
    const m = await managerFor(true, host);
    await expect(m.resume([entry('agent-a')])).resolves.toBeUndefined();
    expect(m.get('agent-a')).toBeUndefined();
  });

  it('experiments come from the entry, not from config', async () => {
    const { host } = resumingHost();
    const m = await managerFor(false, host);
    await m.resume([entry('exp-a', { experiments: { fingerprinting: true, page_diffing: false, mouse_humanization: true, bogus: true } })]);
    expect(experimentRegistry.isEnabled('fingerprinting', 'exp-a')).toBe(true);
    expect(experimentRegistry.isEnabled('page_diffing', 'exp-a')).toBe(false);
    expect(getSession('exp-a')).toBeDefined(); // mouse humanization session was created
  });

  it('attachedTabId is rehydrated through getTabs', async () => {
    const sendCmd = vi.fn(async (method: string) =>
      method === 'getTabs' ? { tabs: [{ id: 7, index: 0, title: 'T', url: 'https://example.com/', attached: true }] } : {});
    const { host } = resumingHost({ sendCmd, attachedTabId: 7 });
    const m = await managerFor(false, host);
    await m.resume([entry('my-project', { attachedTabId: 7 })]);
    expect((m as any)._lobby.attachedTab.id).toBe(7);
    await vi.waitFor(() => expect((m as any)._lobby.attachedTab.url).toBe('https://example.com/'));
    expect(sendCmd.mock.calls.map((c) => c[0])).toContain('getTabs');
  });
});

describe('resumable flag on links', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('connect opens a resumable link and never sends resume', async () => {
    const { host } = resumingHost();
    const m = await managerFor(false, host);
    await m.callTool('connect', { client_id: 'my-project' });
    const opts = (host.openLink as any).mock.calls[0][0];
    expect(opts.resumable).toBe(true);
    expect(opts.resume).toBeUndefined();
  });

  it('a playbook run session opens its link with resumable: false', async () => {
    const host = createFakeHost({ runConfig: () => makeConfig(false), openLink: vi.fn(async () => fakeLink()) });
    const s = defaultBackend(host) as unknown as AgentSession;
    await s.callTool('connect', { username: 'playbook-x-1-2' }, { rawResult: true });
    expect((host.openLink as any).mock.calls[0][0].resumable).toBe(false);
  });

  it('the profile-tools temp link sets no resumable', async () => {
    const host = createFakeHost({ openLink: vi.fn(async () => fakeLink({ sendCmd: vi.fn().mockResolvedValue({ profiles: [] }) })) });
    const s = new AgentSession(makeConfig(false), host);
    await s.callTool('profile_list', {}, { rawResult: true });
    const opts = (host.openLink as any).mock.calls[0][0];
    expect(opts.clientId).toMatch(/^profile-mgmt-/);
    expect(opts).not.toHaveProperty('resumable');
    expect(opts).not.toHaveProperty('resume');
  });
});
