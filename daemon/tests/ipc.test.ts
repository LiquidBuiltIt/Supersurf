import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPCServer } from '../src/ipc';
import { SessionRegistry } from '../src/session';
import { RequestScheduler } from '../src/scheduler';
import { DaemonExperimentRegistry } from '../src/experiments/index';
import { ProfileRegistry } from '../src/profiles/registry';
import type { ExtensionBridge } from '../src/extension-bridge';
import { isExtensionCached } from '../src/profiles/extension-source';

vi.mock('../src/profiles/extension-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/profiles/extension-source')>();
  return { ...actual, isExtensionCached: vi.fn().mockReturnValue(true) };
});

function mockBridge(): ExtensionBridge {
  // Real (if minimal) version-rejection bookkeeping so tests can exercise the
  // recordVersionRejection -> requestMatch fast-fail path end to end, the way
  // the real Matchmaker does it (daemon/src/profiles/matchmaker.ts).
  const versionRejections = new Map<string, { profile: string | null; version: string | null; message: string }>();

  return {
    sendCmd: vi.fn().mockResolvedValue({ success: true }),
    connected: true,
    browser: 'chrome',
    buildTime: '2026-01-01T00:00:00Z',
    extensionVersionError: null,
    notifyClientId: vi.fn(),
    onReconnect: null,
    onTabInfoUpdate: null,
    start: vi.fn(),
    stop: vi.fn(),
    sendCmdToProfile: vi.fn().mockResolvedValue({}),
    matchmaker: {
      getConnectionForProfile: vi.fn().mockReturnValue(null),
      enqueueBootstrap: vi.fn(async (fn: () => Promise<void>) => { await fn(); }),
      pendingSpawns: new Set<string>(),
      requestMatch: vi.fn(async (profile: string | null) => {
        const rejection = versionRejections.get(profile ?? '');
        if (rejection) throw new Error(rejection.message);
        return { profile: 'x' };
      }),
      recordVersionRejection: vi.fn((rejection: { profile: string | null; version: string | null; message: string }) => {
        versionRejections.set(rejection.profile ?? '', rejection);
      }),
    },
  } as any;
}

function connectToSocket(sockPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    socket.on('connect', () => resolve(socket));
    socket.on('error', reject);
  });
}

function readLine(socket: net.Socket): Promise<any> {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        socket.removeListener('data', onData);
        resolve(JSON.parse(buffer.slice(0, idx)));
      }
    };
    socket.on('data', onData);
  });
}

function writeLine(socket: net.Socket, data: any): void {
  socket.write(JSON.stringify(data) + '\n');
}

describe('IPCServer', () => {
  let bridge: ExtensionBridge;
  let sessions: SessionRegistry;
  let scheduler: RequestScheduler;
  let experiments: DaemonExperimentRegistry;
  let profileRegistry: ProfileRegistry;
  let ipc: IPCServer;
  let sockPath: string;
  let tmpDir: string;
  const baseDir = path.join(__dirname, '..', '.tmp-test');

  beforeEach(() => {
    // Use project-local tmp dir to avoid sandbox restrictions on Unix sockets
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(baseDir, 'ipc-'));
    sockPath = path.join(tmpDir, 'test.sock');

    bridge = mockBridge();
    sessions = new SessionRegistry();
    scheduler = new RequestScheduler(bridge, sessions);
    experiments = new DaemonExperimentRegistry();
    profileRegistry = new ProfileRegistry(path.join(tmpDir, 'profiles'));
    ipc = new IPCServer(sockPath, bridge, sessions, scheduler, experiments, profileRegistry, { port: 5555, version: '9.9.9-test' });
  });

  afterEach(async () => {
    await ipc.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('starts and accepts connections', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'test-session' });
    const response = await readLine(client);

    expect(response.type).toBe('session_ack');
    expect(response.browser).toBe('chrome');
    expect(response.buildTimestamp).toBe('2026-01-01T00:00:00Z');
    expect(response.capabilities).toBeUndefined();

    client.end();
  });

  it('includes the daemon version on session_ack', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'ver-session' });
    const response = await readLine(client);

    expect(response.type).toBe('session_ack');
    expect(response.version).toBe('9.9.9-test');

    client.end();
  });

  it('reports extensionConnected=false on session_ack when no unmanaged extension is pooled', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'ext-false-session' });
    const response = await readLine(client);

    expect(response.type).toBe('session_ack');
    expect(response.extensionConnected).toBe(false);

    client.end();
  });

  it('reports extensionConnected=true on session_ack when an unmanaged extension is pooled', async () => {
    (bridge.matchmaker.getConnectionForProfile as any).mockReturnValue({ profile: null, browser: 'chrome' });
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'ext-true-session' });
    const response = await readLine(client);

    expect(response.type).toBe('session_ack');
    expect(response.extensionConnected).toBe(true);

    client.end();
  });

  it('reports extensionVersionError on session_ack when set', async () => {
    (bridge as any).extensionVersionError =
      'Extension version 2.9.0 is not compatible with SuperSurf 3.4.0.';
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'sess-version-check' });
    const response = await readLine(client);

    expect(response.type).toBe('session_ack');
    expect(response.extensionVersionError).toContain('not compatible');

    client.end();
  });

  it('reports null extensionVersionError when no rejection is recorded', async () => {
    (bridge as any).extensionVersionError = null;
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'sess-version-ok' });
    const response = await readLine(client);

    expect(response.type).toBe('session_ack');
    expect(response.extensionVersionError).toBeNull();

    client.end();
  });

  it('rejects duplicate session IDs', async () => {
    await ipc.start();

    // First client registers
    const client1 = await connectToSocket(sockPath);
    writeLine(client1, { type: 'session_register', sessionId: 'dup' });
    await readLine(client1);

    // Second client tries same ID
    const client2 = await connectToSocket(sockPath);
    writeLine(client2, { type: 'session_register', sessionId: 'dup' });
    const response = await readLine(client2);

    expect(response.type).toBe('session_reject');
    expect(response.reason).toContain('already in use');

    client1.end();
    client2.end();
  });

  it('rejects non-handshake messages before registration', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { jsonrpc: '2.0', id: '1', method: 'navigate' });
    const response = await readLine(client);

    expect(response.type).toBe('session_reject');

    client.end();
  });

  it('routes JSON-RPC requests post-handshake', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    // Handshake
    writeLine(client, { type: 'session_register', sessionId: 'my-session' });
    await readLine(client); // ack

    // Send a tool call
    writeLine(client, {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'navigate',
      params: { url: 'https://example.com' },
    });

    const response = await readLine(client);
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('req-1');
    expect(response.result).toBeDefined();

    client.end();
  });

  it('cleans up session on socket close', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'cleanup-test' });
    await readLine(client);

    expect(sessions.has('cleanup-test')).toBe(true);

    // Close the client
    client.end();

    // Wait for cleanup
    await new Promise(r => setTimeout(r, 50));

    expect(sessions.has('cleanup-test')).toBe(false);
  });

  it('calls session count callback on connect/disconnect', async () => {
    const countCb = vi.fn();
    ipc.setSessionCountCallback(countCb);

    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'count-test' });
    await readLine(client);

    expect(countCb).toHaveBeenCalledWith(1);

    client.end();
    await new Promise(r => setTimeout(r, 50));

    expect(countCb).toHaveBeenCalledWith(0);
  });

  it('handles concurrent sessions', async () => {
    await ipc.start();

    const client1 = await connectToSocket(sockPath);
    const client2 = await connectToSocket(sockPath);

    writeLine(client1, { type: 'session_register', sessionId: 'session-a' });
    writeLine(client2, { type: 'session_register', sessionId: 'session-b' });

    await readLine(client1);
    await readLine(client2);

    expect(sessions.count).toBe(2);
    expect(sessions.has('session-a')).toBe(true);
    expect(sessions.has('session-b')).toBe(true);

    client1.end();
    client2.end();
  });

  // ── Experiment IPC ──────────────────────────────────────────

  it('handles experiments.toggle without going through scheduler', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'exp-test' });
    await readLine(client);

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'exp-1',
      method: 'experiments.toggle',
      params: { experiment: 'page_diffing', enabled: true },
    });

    const response = await readLine(client);
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe('exp-1');
    expect(response.result.success).toBe(true);
    expect(response.result.experiment).toBe('page_diffing');
    expect(response.result.enabled).toBe(true);

    // Verify state was stored
    expect(experiments.isEnabled('exp-test', 'page_diffing')).toBe(true);

    client.end();
  });

  it('handles experiments.get', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'exp-get' });
    await readLine(client);

    // Enable one experiment first
    writeLine(client, {
      jsonrpc: '2.0',
      id: 'toggle-1',
      method: 'experiments.toggle',
      params: { experiment: 'smart_waiting', enabled: true },
    });
    await readLine(client);

    // Get all states
    writeLine(client, {
      jsonrpc: '2.0',
      id: 'get-1',
      method: 'experiments.get',
      params: {},
    });

    const response = await readLine(client);
    expect(response.id).toBe('get-1');
    expect(response.result.experiments.smart_waiting).toBe(true);
    expect(response.result.experiments.page_diffing).toBe(false);

    client.end();
  });

  it('handles experiments.getOne', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'exp-one' });
    await readLine(client);

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'one-1',
      method: 'experiments.getOne',
      params: { experiment: 'page_diffing' },
    });

    const response = await readLine(client);
    expect(response.id).toBe('one-1');
    expect(response.result.experiment).toBe('page_diffing');
    expect(response.result.enabled).toBe(false);

    client.end();
  });

  it('returns error for unknown experiment in toggle', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'exp-err' });
    await readLine(client);

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'err-1',
      method: 'experiments.toggle',
      params: { experiment: 'warp_drive', enabled: true },
    });

    const response = await readLine(client);
    expect(response.id).toBe('err-1');
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain('Unknown experiment');

    client.end();
  });

  it('cleans up experiment state on session disconnect', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'exp-cleanup' });
    await readLine(client);

    // Enable an experiment
    writeLine(client, {
      jsonrpc: '2.0',
      id: 'c-1',
      method: 'experiments.toggle',
      params: { experiment: 'page_diffing', enabled: true },
    });
    await readLine(client);

    expect(experiments.isEnabled('exp-cleanup', 'page_diffing')).toBe(true);

    // Disconnect
    client.end();
    await new Promise(r => setTimeout(r, 50));

    // After disconnect, isEnabled falls back to defaults (false)
    expect(experiments.isEnabled('exp-cleanup', 'page_diffing')).toBe(false);
  });

  // ── daemon_status query ─────────────────────────────────────

  it('responds to daemon_status without handshake', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'daemon_status' });
    const response = await readLine(client);

    expect(response.type).toBe('daemon_status');
    expect(response.version).toBeDefined();
    expect(response.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(response.port).toBe(5555);
    expect(response.extensionConnected).toBe(true); // mock bridge
    expect(response.sessions).toEqual([]);
    expect(response.schedulerQueueDepth).toBe(0);

    client.end();
  });

  it('daemon_status includes connected sessions', async () => {
    await ipc.start();

    // Register a session first
    const session = await connectToSocket(sockPath);
    writeLine(session, { type: 'session_register', sessionId: 'status-test' });
    await readLine(session);

    // Query status from a separate connection
    const query = await connectToSocket(sockPath);
    writeLine(query, { type: 'daemon_status' });
    const response = await readLine(query);

    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].sessionId).toBe('status-test');
    expect(response.sessions[0].ownedTabCount).toBe(0);

    session.end();
    query.end();
  });

  // ── Profile IPC ──────────────────────────────────────────────

  it('handles profiles.create and profiles.list', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'create-test' });
    await readLine(client);

    // Create
    writeLine(client, {
      jsonrpc: '2.0',
      id: 'create-1',
      method: 'profiles.create',
      params: { name: 'test-profile' },
    });

    const createResponse = await readLine(client);
    expect(createResponse.result.success).toBe(true);
    expect(createResponse.result.profile.name).toBe('test-profile');

    // List
    writeLine(client, {
      jsonrpc: '2.0',
      id: 'list-1',
      method: 'profiles.list',
      params: {},
    });

    const listResponse = await readLine(client);
    expect(listResponse.result.profiles).toHaveLength(1);
    expect(listResponse.result.profiles[0].name).toBe('test-profile');

    client.end();
  });

  it('handles profiles.delete', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'delete-test' });
    await readLine(client);

    // Create first
    writeLine(client, {
      jsonrpc: '2.0',
      id: 'd-1',
      method: 'profiles.create',
      params: { name: 'to-delete' },
    });
    await readLine(client);

    // Delete
    writeLine(client, {
      jsonrpc: '2.0',
      id: 'd-2',
      method: 'profiles.delete',
      params: { name: 'to-delete' },
    });

    const response = await readLine(client);
    expect(response.result.success).toBe(true);
    expect(profileRegistry.exists('to-delete')).toBe(false);

    client.end();
  });

  it('handles profiles.rename', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'rename-test' });
    await readLine(client);

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'r-1',
      method: 'profiles.create',
      params: { name: 'before' },
    });
    await readLine(client);

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'r-2',
      method: 'profiles.rename',
      params: { name: 'before', newName: 'after' },
    });

    const response = await readLine(client);
    expect(response.result.success).toBe(true);
    expect(response.result.profile.name).toBe('after');
    expect(profileRegistry.exists('before')).toBe(false);
    expect(profileRegistry.exists('after')).toBe(true);

    client.end();
  });

  it('refuses profiles.rename while the profile is running', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'rename-refuse-test' });
    await readLine(client);

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'rr-1',
      method: 'profiles.create',
      params: { name: 'live' },
    });
    await readLine(client);

    profileRegistry.setRunningPid('live', process.pid, 'daemon');

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'rr-2',
      method: 'profiles.rename',
      params: { name: 'live', newName: 'renamed' },
    });

    const response = await readLine(client);
    expect(response.error).toBeDefined();
    expect(response.error.message).toMatch(/is running/);
    expect(profileRegistry.exists('live')).toBe(true);

    client.end();
  });

  it('refuses profiles.delete with refuseIfRunning while the profile is running (CLI failsafe)', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'delete-refuse-test' });
    await readLine(client);

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'dr-1',
      method: 'profiles.create',
      params: { name: 'live-delete' },
    });
    await readLine(client);

    profileRegistry.setRunningPid('live-delete', process.pid, 'daemon');

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'dr-2',
      method: 'profiles.delete',
      params: { name: 'live-delete', refuseIfRunning: true },
    });

    const response = await readLine(client);
    expect(response.error).toBeDefined();
    expect(response.error.message).toMatch(/is running \(PID \d+\) — stop it first\./);
    expect(profileRegistry.exists('live-delete')).toBe(true);

    client.end();
  });

  it('regression lock: profiles.delete without refuseIfRunning still kills a daemon-owned running browser (MCP profile_delete unchanged)', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'delete-mcp-test' });
    await readLine(client);

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'dm-1',
      method: 'profiles.create',
      params: { name: 'mcp-owned' },
    });
    await readLine(client);

    profileRegistry.setRunningPid('mcp-owned', 999999999, 'daemon'); // certainly not alive, avoids a real kill

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'dm-2',
      method: 'profiles.delete',
      params: { name: 'mcp-owned' },
    });

    const response = await readLine(client);
    expect(response.result.success).toBe(true);
    expect(profileRegistry.exists('mcp-owned')).toBe(false);

    client.end();
  });

  it('isolates experiment state between sessions', async () => {
    await ipc.start();

    const client1 = await connectToSocket(sockPath);
    const client2 = await connectToSocket(sockPath);

    writeLine(client1, { type: 'session_register', sessionId: 'iso-a' });
    writeLine(client2, { type: 'session_register', sessionId: 'iso-b' });
    await readLine(client1);
    await readLine(client2);

    // Enable page_diffing for session A only
    writeLine(client1, {
      jsonrpc: '2.0',
      id: 'iso-1',
      method: 'experiments.toggle',
      params: { experiment: 'page_diffing', enabled: true },
    });
    await readLine(client1);

    expect(experiments.isEnabled('iso-a', 'page_diffing')).toBe(true);
    expect(experiments.isEnabled('iso-b', 'page_diffing')).toBe(false);

    client1.end();
    client2.end();
  });

  describe('config drift envelope', () => {
    it('omits config_drift from session_ack when no drift', async () => {
      await ipc.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'drift-off' });
      const ack = await readLine(client);
      expect(ack.type).toBe('session_ack');
      expect(ack.config_drift).toBeUndefined();
      client.end();
    });

    it('injects config_drift into session_ack when daemon flagged drift', async () => {
      ipc.setConfigDrift(true);
      await ipc.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'drift-on' });
      const ack = await readLine(client);
      expect(ack.config_drift).toBe(true);
      client.end();
    });

    it('injects config_drift into JSON-RPC responses when drift is flagged mid-session', async () => {
      await ipc.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'drift-mid' });
      await readLine(client);

      // Flip drift after handshake, then make any RPC call
      ipc.setConfigDrift(true);
      writeLine(client, {
        jsonrpc: '2.0',
        id: 'q1',
        method: 'experiments.get',
        params: {},
      });
      const response = await readLine(client);
      expect(response.jsonrpc).toBe('2.0');
      expect(response.config_drift).toBe(true);
      client.end();
    });
  });

  describe('profiles.launch + user-owned lifecycle', () => {
    it('rejects launch of a nonexistent profile', async () => {
      await ipc.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'launch-404' });
      await readLine(client);

      writeLine(client, { jsonrpc: '2.0', id: 'l1', method: 'profiles.launch', params: { profile: 'ghost' } });
      const res = await readLine(client);
      expect(res.error).toBeDefined();
      expect(res.error.message).toContain('not found');
      client.end();
    });

    it('reports alreadyRunning without spawning when a pooled connection exists', async () => {
      await ipc.start();
      profileRegistry.create('dev');
      (bridge as any).matchmaker.getConnectionForProfile.mockReturnValue({ profile: 'dev' });

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'launch-dup' });
      await readLine(client);

      writeLine(client, { jsonrpc: '2.0', id: 'l2', method: 'profiles.launch', params: { profile: 'dev' } });
      const res = await readLine(client);
      expect(res.result.success).toBe(true);
      expect(res.result.alreadyRunning).toBe(true);
      expect((bridge as any).matchmaker.enqueueBootstrap).not.toHaveBeenCalled();
      client.end();
    });

    it('profiles.connect skips spawn when a pooled connection exists (pool-aware guard)', async () => {
      await ipc.start();
      profileRegistry.create('dev');
      (bridge as any).matchmaker.getConnectionForProfile.mockReturnValue({ profile: 'dev' });
      (bridge as any).matchmaker.requestMatch.mockResolvedValue({ profile: 'dev' });

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'connect-pooled' });
      await readLine(client);

      writeLine(client, { jsonrpc: '2.0', id: 'c1', method: 'profiles.connect', params: { profile: 'dev' } });
      const res = await readLine(client);
      expect(res.result).toBeDefined();
      expect((bridge as any).matchmaker.enqueueBootstrap).not.toHaveBeenCalled();
      client.end();
    });

    it('profiles.connect rejects fast when the spawned Chromium dies before matching', async () => {
      await ipc.start();
      profileRegistry.create('deadprof');
      // Spawn succeeds (no-op), but nothing ever gets pooled and the process
      // never registers as running -> death watch should reject quickly.
      const spawnSpy = vi.spyOn(ipc as any, 'spawnProfile').mockResolvedValue(undefined);
      (bridge as any).matchmaker.getConnectionForProfile.mockReturnValue(null);
      (bridge as any).matchmaker.requestMatch.mockReturnValue(new Promise(() => {})); // never matches
      vi.spyOn(profileRegistry, 'isRunning').mockReturnValue(false);

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'dead-chromium' });
      await readLine(client);

      writeLine(client, { jsonrpc: '2.0', id: 'c-dead', method: 'profiles.connect', params: { profile: 'deadprof' } });
      const res = await readLine(client);

      expect(spawnSpy).toHaveBeenCalledOnce();
      expect(res.error).toBeDefined();
      expect(res.error.message).toContain('exited before the extension connected');
      client.end();
    });

    it('propagates a matchmaker version rejection as a named profiles.connect error', async () => {
      // The whole point of the item: a named error now, not a 45s timeout.
      // Scope note: mockBridge()'s matchmaker stub supplies the fast-fail, so
      // what this locks is the IPC path — profiles.connect gets past the
      // "Profile not found" guard, reaches requestMatch, and surfaces the
      // rejection instead of swallowing it. The fast-fail itself is locked in
      // tests/profiles/matchmaker.test.ts.
      await ipc.start();
      profileRegistry.create('dev');
      (bridge as any).matchmaker.getConnectionForProfile.mockReturnValue({ profile: 'dev' });
      (bridge as any).matchmaker.recordVersionRejection({
        profile: 'dev',
        version: '2.9.0',
        message: 'Extension version 2.9.0 is not compatible with SuperSurf 3.4.0.',
      });

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'version-rejected' });
      await readLine(client);

      const start = Date.now();
      writeLine(client, { jsonrpc: '2.0', id: 'c-verfail', method: 'profiles.connect', params: { profile: 'dev' } });
      const res = await readLine(client);

      expect(res.error).toBeDefined();
      expect(res.error.message).toContain('not compatible');
      expect(Date.now() - start).toBeLessThan(5000);
      client.end();
    });

    it('does NOT kill a user-owned Chromium when the last session disconnects', async () => {
      await ipc.start();
      profileRegistry.create('dev');
      profileRegistry.setRunningPid('dev', 999999, 'user'); // dead pid; kill would throw anyway — we assert it isn't cleared
      (bridge as any).matchmaker.getConnectionForProfile.mockReturnValue({ profile: 'dev' });
      (bridge as any).matchmaker.requestMatch.mockResolvedValue({ profile: 'dev' });

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'owner-guard' });
      await readLine(client);
      writeLine(client, { jsonrpc: '2.0', id: 'c2', method: 'profiles.connect', params: { profile: 'dev' } });
      await readLine(client); // session now bound to profile 'dev'

      client.end();
      await new Promise((r) => setTimeout(r, 150)); // let the close handler run

      expect(profileRegistry.getRunningPid('dev')).toBe(999999); // untouched
    });

    it('kills (clears) a daemon-owned Chromium when keepBrowserOnSessionEnd is false', async () => {
      await ipc.start();
      profileRegistry.create('dev');
      profileRegistry.setRunningPid('dev', 999999, 'daemon');
      (bridge as any).matchmaker.getConnectionForProfile.mockReturnValue({
        profile: 'dev',
        keepBrowserOnSessionEnd: false,
      });
      (bridge as any).matchmaker.requestMatch.mockResolvedValue({ profile: 'dev' });

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'daemon-kill' });
      await readLine(client);
      writeLine(client, { jsonrpc: '2.0', id: 'c3', method: 'profiles.connect', params: { profile: 'dev' } });
      await readLine(client);

      client.end();
      await new Promise((r) => setTimeout(r, 150));

      expect(profileRegistry.getRunningPid('dev')).toBeNull(); // kill path ran, pid cleared
    });

    it('does NOT kill daemon-owned Chromium when keepBrowserOnSessionEnd is true', async () => {
      await ipc.start();
      profileRegistry.create('dev');
      profileRegistry.setRunningPid('dev', 999999, 'daemon');
      (bridge as any).matchmaker.getConnectionForProfile.mockReturnValue({
        profile: 'dev',
        keepBrowserOnSessionEnd: true,
      });
      (bridge as any).matchmaker.requestMatch.mockResolvedValue({ profile: 'dev' });

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'keep-true' });
      await readLine(client);
      writeLine(client, { jsonrpc: '2.0', id: 'c', method: 'profiles.connect', params: { profile: 'dev' } });
      await readLine(client);

      client.end();
      await new Promise((r) => setTimeout(r, 150));

      expect(profileRegistry.getRunningPid('dev')).toBe(999999);
    });

    it('kills daemon-owned Chromium when keep field is missing (opt-in default)', async () => {
      await ipc.start();
      profileRegistry.create('dev');
      profileRegistry.setRunningPid('dev', 999999, 'daemon');
      (bridge as any).matchmaker.getConnectionForProfile.mockReturnValue({ profile: 'dev' });
      (bridge as any).matchmaker.requestMatch.mockResolvedValue({ profile: 'dev' });

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'keep-default' });
      await readLine(client);
      writeLine(client, { jsonrpc: '2.0', id: 'c', method: 'profiles.connect', params: { profile: 'dev' } });
      await readLine(client);

      client.end();
      await new Promise((r) => setTimeout(r, 150));

      expect(profileRegistry.getRunningPid('dev')).toBeNull();
    });

    it('kills when no extension connection is pooled (fail closed)', async () => {
      await ipc.start();
      profileRegistry.create('dev');
      profileRegistry.setRunningPid('dev', 999999, 'daemon');
      (bridge as any).matchmaker.getConnectionForProfile.mockReturnValue(null);
      (bridge as any).matchmaker.requestMatch.mockResolvedValue({ profile: 'dev' });

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'keep-nopool' });
      await readLine(client);
      writeLine(client, { jsonrpc: '2.0', id: 'c', method: 'profiles.connect', params: { profile: 'dev' } });
      await readLine(client);

      client.end();
      await new Promise((r) => setTimeout(r, 150));

      expect(profileRegistry.getRunningPid('dev')).toBeNull(); // kill path ran, pid cleared
    });

    it('profiles.list includes owner and connected fields', async () => {
      await ipc.start();
      profileRegistry.create('dev');

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'list-enriched' });
      await readLine(client);

      writeLine(client, { jsonrpc: '2.0', id: 'ls1', method: 'profiles.list', params: {} });
      const res = await readLine(client);
      expect(res.result.profiles).toHaveLength(1);
      expect(res.result.profiles[0]).toMatchObject({
        name: 'dev',
        running: false,
        owner: null,
        connected: false,
      });
      client.end();
    });
  });

  describe('extension pull failure', () => {
    function makeIpcServer(metaOverrides: Record<string, unknown> = {}): IPCServer {
      return new IPCServer(sockPath, bridge, sessions, scheduler, experiments, profileRegistry, {
        port: 5555,
        version: '9.9.9-test',
        ...metaOverrides,
      });
    }

    async function callProfileMethod(
      sessionId: string,
      method: string,
      params: Record<string, unknown>,
      server: IPCServer,
    ): Promise<any> {
      await server.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId });
      await readLine(client);

      writeLine(client, { jsonrpc: '2.0', id: 'req-1', method, params });
      const res = await readLine(client);
      client.end();
      if (res.error) throw new Error(res.error.message);
      return res.result;
    }

    beforeEach(() => {
      profileRegistry.create('dev');
    });

    it('fails profiles.connect with the pull error when the extension is not cached', async () => {
      ipc = makeIpcServer({
        extensionPullError: 'getaddrinfo ENOTFOUND api.github.com',
      });
      vi.mocked(isExtensionCached).mockReturnValue(false);

      await expect(
        callProfileMethod('sess-1', 'profiles.connect', { profile: 'dev' }, ipc),
      ).rejects.toThrow(/could not download the browser extension/i);
    });

    it('names the underlying pull error so the user can act on it', async () => {
      ipc = makeIpcServer({
        extensionPullError: 'getaddrinfo ENOTFOUND api.github.com',
      });
      vi.mocked(isExtensionCached).mockReturnValue(false);

      await expect(
        callProfileMethod('sess-1', 'profiles.connect', { profile: 'dev' }, ipc),
      ).rejects.toThrow(/ENOTFOUND api\.github\.com/);
    });

    it('spawns normally when the extension is cached despite an earlier pull error', async () => {
      ipc = makeIpcServer({
        extensionPullError: 'getaddrinfo ENOTFOUND api.github.com',
      });
      vi.mocked(isExtensionCached).mockReturnValue(true);
      // Skip the real bootstrap queue (would spawn a real Chromium); the
      // point of this test is only that the pull-error guard doesn't fire.
      (bridge as any).matchmaker.enqueueBootstrap = vi.fn().mockResolvedValue(undefined);

      // A stale-but-present cache is usable; the pull failure is not fatal —
      // the guard is a no-op and the connect proceeds to a normal match.
      const result = await callProfileMethod('sess-1', 'profiles.connect', { profile: 'dev' }, ipc);
      expect(result.success).toBe(true);
    });
  });
});
