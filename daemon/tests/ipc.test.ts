import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IPCServer, socketSink, type IPCServerMeta } from '../src/ipc';
import type { SessionSink } from '../src/types';
import { SessionRegistry } from '../src/session';
import { RequestScheduler } from '../src/scheduler';
import { DaemonExperimentRegistry } from '../src/experiments/index';
import { ProfileRegistry } from '../src/profiles/registry';
import type { ExtensionBridge } from '../src/extension-bridge';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { attachEnginePort, portSink, type EnginePortHooks } from '../src/engine-worker/main-side';
import { PortLinkRouter } from '../src/engine-worker/port-link';
import type { MainToWorker, WorkerToMain } from '../src/engine-worker/protocol';
import { isExtensionCached } from '../src/profiles/extension-source';

// spawnProfile calls spawnChromium for real. The pull-error guard currently
// throws before it is reached, but a regression that removed the guard would
// otherwise launch a real browser from the test suite and write the real PID
// log. Stub it so the failure mode is a red test, not a window.
vi.mock('../src/profiles/chrome', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/profiles/chrome')>();
  return {
    ...actual,
    spawnChromium: vi.fn(() => ({ pid: 1234, on: vi.fn(), unref: vi.fn() })),
    // Also stubbed: the real one appends the fake pid to the real PID log.
    appendPidLog: vi.fn(),
  };
});

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

/** First line as raw bytes, trailing newline included, no JSON.parse. */
function readRawLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        socket.removeListener('data', onData);
        resolve(buffer.slice(0, idx + 1));
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

  /** Register two clients under the same session id; return the second
   *  client's session_reject envelope. */
  async function registerTwice(id: string): Promise<any> {
    await ipc.start();

    const client1 = await connectToSocket(sockPath);
    writeLine(client1, { type: 'session_register', sessionId: id });
    await readLine(client1);

    const client2 = await connectToSocket(sockPath);
    writeLine(client2, { type: 'session_register', sessionId: id });
    const reject = await readLine(client2);

    client1.end();
    client2.end();
    return reject;
  }

  /** Register a first session, then a second under a different id; return
   *  the second client's session_ack envelope. */
  async function registerSecondSession(firstId: string, secondId: string): Promise<any> {
    await ipc.start();

    const client1 = await connectToSocket(sockPath);
    writeLine(client1, { type: 'session_register', sessionId: firstId });
    await readLine(client1);

    const client2 = await connectToSocket(sockPath);
    writeLine(client2, { type: 'session_register', sessionId: secondId });
    const ack = await readLine(client2);

    client1.end();
    client2.end();
    return ack;
  }

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

  it('reports activeSessionCount=1 on session_ack for the only session', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'solo-session' });
    const response = await readLine(client);

    expect(response.type).toBe('session_ack');
    expect(response.activeSessionCount).toBe(1);

    client.end();
  });

  it('reports activeSessionCount including the caller when other sessions are already connected', async () => {
    await ipc.start();
    const client1 = await connectToSocket(sockPath);
    writeLine(client1, { type: 'session_register', sessionId: 'first-session' });
    await readLine(client1);

    const client2 = await connectToSocket(sockPath);
    writeLine(client2, { type: 'session_register', sessionId: 'second-session' });
    const response2 = await readLine(client2);

    expect(response2.activeSessionCount).toBe(2);

    client1.end();
    client2.end();
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

  it('names the conflicting session when a client_id is already in use', async () => {
    const reject = await registerTwice('dup');
    expect(reject.type).toBe('session_reject');
    expect(reject.reason).toContain('dup');
    expect(reject.reason).toMatch(/already in use/i);
  });

  it('rejects a duplicate session with the username text', async () => {
    const reject = await registerTwice('sm-a');
    expect(reject.reason).toBe('Username "sm-a" is already in use by a live agent. Pick another username and call `connect` again.');
  });

  it('sends the created tabs on session close', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);
    writeLine(client, { type: 'session_register', sessionId: 'sm-a' });
    await readLine(client);
    sessions.addCreatedTab('sm-a', 99);
    client.end();
    await new Promise(r => setTimeout(r, 50));
    expect(bridge.sendCmd).toHaveBeenCalledWith('sessionDisconnect', { sessionId: 'sm-a', closeTabIds: [99] }, 5000);
  });

  it('a rejected duplicate does not end the live session when its socket closes', async () => {
    await ipc.start();
    const live = await connectToSocket(sockPath);
    writeLine(live, { type: 'session_register', sessionId: 'x' });
    await readLine(live);
    sessions.addCreatedTab('x', 7);

    const dup = await connectToSocket(sockPath);
    writeLine(dup, { type: 'session_register', sessionId: 'x' });
    expect((await readLine(dup)).type).toBe('session_reject');
    dup.destroy();
    await new Promise(r => setTimeout(r, 50));

    expect(sessions.has('x')).toBe(true);
    expect(bridge.sendCmd).not.toHaveBeenCalledWith('sessionDisconnect', expect.anything(), expect.anything());
    live.end();
  });

  it('puts the other live session ids on the envelope', async () => {
    const ack = await registerSecondSession('sm-a', 'sm-b');
    expect(ack.peers).toEqual(['sm-a']);
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

    expect(countCb.mock.calls).toEqual([[1]]);

    client.end();
    await new Promise(r => setTimeout(r, 50));

    expect(countCb.mock.calls).toEqual([[1], [0]]);
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

  describe('wire bytes (E1b golden)', () => {
    const ackHead =
      '{"type":"session_ack","browser":"chrome","buildTimestamp":"2026-01-01T00:00:00Z",' +
      '"version":"9.9.9-test","extensionConnected":false,"extensionVersionError":null,';

    it('session_ack bytes, no drift, single session', async () => {
      await ipc.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'g1' });
      expect(await readRawLine(client)).toBe(ackHead + '"activeSessionCount":1,"peers":[]}\n');
      client.end();
    });

    it('session_ack bytes with drift and a peer: config_drift before peers', async () => {
      await ipc.start();
      const first = await connectToSocket(sockPath);
      writeLine(first, { type: 'session_register', sessionId: 'first' });
      await readLine(first);
      ipc.setConfigDrift(true);

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'g2' });
      expect(await readRawLine(client)).toBe(
        ackHead + '"activeSessionCount":2,"config_drift":true,"peers":["first"]}\n',
      );
      first.end();
      client.end();
    });

    it('post-handshake JSON-RPC result bytes include peers', async () => {
      await ipc.start();
      const first = await connectToSocket(sockPath);
      writeLine(first, { type: 'session_register', sessionId: 'first' });
      await readLine(first);
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'g3' });
      await readLine(client);

      writeLine(client, {
        jsonrpc: '2.0', id: 'q1', method: 'experiments.getOne', params: { experiment: 'nope' },
      });
      expect(await readRawLine(client)).toBe(
        '{"jsonrpc":"2.0","id":"q1","result":{"experiment":"nope","enabled":false},"peers":["first"]}\n',
      );
      first.end();
      client.end();
    });

    it('duplicate session_reject bytes carry no peers and no config_drift', async () => {
      await ipc.start();
      const live = await connectToSocket(sockPath);
      writeLine(live, { type: 'session_register', sessionId: 'dup' });
      await readLine(live);
      ipc.setConfigDrift(true);

      const second = await connectToSocket(sockPath);
      writeLine(second, { type: 'session_register', sessionId: 'dup' });
      expect(await readRawLine(second)).toBe(
        '{"type":"session_reject","reason":"Username \\"dup\\" is already in use by a live agent. ' +
        'Pick another username and call `connect` again."}\n',
      );
      live.end();
      second.end();
    });

    it('missing-handshake session_reject bytes', async () => {
      await ipc.start();
      ipc.setConfigDrift(true);
      const client = await connectToSocket(sockPath);
      writeLine(client, { jsonrpc: '2.0', id: '1', method: 'navigate' });
      expect(await readRawLine(client)).toBe(
        '{"type":"session_reject","reason":"Expected session_register handshake"}\n',
      );
      client.end();
    });

    it('a socket that closes before its response is ready: nothing throws, session cleaned up', async () => {
      const errors: unknown[] = [];
      const onErr = (e: unknown) => errors.push(e);
      process.on('uncaughtException', onErr);
      process.on('unhandledRejection', onErr);
      try {
        let release!: (v: unknown) => void;
        (bridge.sendCmd as any).mockImplementationOnce(() => new Promise((r) => { release = r; }));

        await ipc.start();
        const client = await connectToSocket(sockPath);
        writeLine(client, { type: 'session_register', sessionId: 'early' });
        await readLine(client);
        writeLine(client, { jsonrpc: '2.0', id: 'r1', method: 'navigate', params: {} });
        await vi.waitFor(() => expect(bridge.sendCmd).toHaveBeenCalledTimes(1));

        client.destroy();
        await vi.waitFor(() => expect(sessions.has('early')).toBe(false));

        release({ success: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(errors).toEqual([]);
        expect(sessions.has('early')).toBe(false);
      } finally {
        process.off('uncaughtException', onErr);
        process.off('unhandledRejection', onErr);
      }
    });
  });

  describe('malformed lines', () => {
    const invalid = (id: unknown = null) => ({
      jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
    });

    it('a null line after the handshake gets -32600, kills nothing, and the session keeps working', async () => {
      const errors: unknown[] = [];
      const onErr = (e: unknown) => errors.push(e);
      process.on('uncaughtException', onErr);
      process.on('unhandledRejection', onErr);
      try {
        await ipc.start();
        const client = await connectToSocket(sockPath);
        writeLine(client, { type: 'session_register', sessionId: 'nul' });
        await readLine(client);

        client.write('null\n');
        expect(await readLine(client)).toMatchObject(invalid());

        writeLine(client, { jsonrpc: '2.0', id: 'ok', method: 'experiments.getOne', params: { experiment: 'x' } });
        expect((await readLine(client)).id).toBe('ok');
        await new Promise((r) => setTimeout(r, 50));
        expect(errors).toEqual([]);
        client.end();
      } finally {
        process.off('uncaughtException', onErr);
        process.off('unhandledRejection', onErr);
      }
    });

    it.each(['5', '"s"', 'true', '[]'])('a %s line after the handshake gets -32600', async (raw) => {
      await ipc.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'odd' });
      await readLine(client);
      client.write(raw + '\n');
      expect(await readLine(client)).toMatchObject(invalid());
      client.end();
    });

    it('request() resolves with -32600 for null', async () => {
      const sent: unknown[] = [];
      const sink = { send: (m: object) => sent.push(m), end: () => {} };
      await expect(ipc.request('m1', sink, null)).resolves.toBeUndefined();
      expect(sent).toMatchObject([invalid()]);
    });

    it('a null line before the handshake gets the same session_reject as any other non-handshake line', async () => {
      await ipc.start();
      const client = await connectToSocket(sockPath);
      client.write('null\n');
      expect(await readLine(client)).toEqual({
        type: 'session_reject', reason: 'Expected session_register handshake',
      });
      client.end();
    });
  });

  describe('SessionHost sinks (E1b)', () => {
    function fakeSink() {
      return {
        sent: [] as any[],
        ended: 0,
        send(m: object) { this.sent.push(m); },
        end() { this.ended++; },
      };
    }

    it('register acks with an object, counts the session and fires the count callback', () => {
      const counts: number[] = [];
      ipc.setSessionCountCallback((n) => counts.push(n));
      const fake = fakeSink();

      expect(ipc.register('m1', fake)).toBe(true);

      expect(typeof fake.sent[0]).toBe('object');
      expect(fake.sent[0]).toEqual({
        type: 'session_ack',
        browser: 'chrome',
        buildTimestamp: '2026-01-01T00:00:00Z',
        version: '9.9.9-test',
        extensionConnected: false,
        extensionVersionError: null,
        activeSessionCount: 1,
        peers: [],
      });
      expect(sessions.has('m1')).toBe(true);
      expect(counts).toEqual([1]);
    });

    it('a sink session is refused when a socket session holds the id', async () => {
      await ipc.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'x' });
      await readLine(client);
      const fake = fakeSink();

      expect(ipc.register('x', fake)).toBe(false);

      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0].type).toBe('session_reject');
      expect(fake.sent[0].reason).toContain('"x" is already in use');
      expect(fake.ended).toBe(1);
      expect(sessions.count).toBe(1);
      client.end();
    });

    it('a socket session is refused when a sink session holds the id', async () => {
      await ipc.start();
      const fake = fakeSink();
      ipc.register('y', fake);

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'y' });
      const reject = await readLine(client);

      expect(reject.type).toBe('session_reject');
      expect(fake.ended).toBe(0);
      expect(sessions.get('y')!.sink).toBe(fake);
      client.end();
    });

    it('request answers with an object that carries peers, and config_drift when flagged', async () => {
      const fake = fakeSink();
      ipc.register('m1', fake);
      const msg = { jsonrpc: '2.0', id: 1, method: 'experiments.getOne', params: { experiment: 'nope' } };

      await ipc.request('m1', fake, msg);
      expect(fake.sent[1]).toEqual({
        jsonrpc: '2.0', id: 1, result: { experiment: 'nope', enabled: false }, peers: [],
      });

      ipc.setConfigDrift(true);
      await ipc.request('m1', fake, msg);
      expect(fake.sent[2].config_drift).toBe(true);
    });

    it('close tears the session down once, and a stale sink is ignored', () => {
      const counts: number[] = [];
      ipc.setSessionCountCallback((n) => counts.push(n));
      const del = vi.spyOn(experiments, 'deleteSession');
      const fake = fakeSink();
      ipc.register('m1', fake);
      sessions.addCreatedTab('m1', 7);

      ipc.close('m1', fakeSink());
      expect(sessions.has('m1')).toBe(true);
      expect(bridge.sendCmd).not.toHaveBeenCalled();

      ipc.close('m1', fake);
      expect(bridge.sendCmd).toHaveBeenCalledWith('sessionDisconnect', { sessionId: 'm1', closeTabIds: [7] }, 5000);
      expect(sessions.has('m1')).toBe(false);
      expect(del).toHaveBeenCalledWith('m1');
      expect(counts).toEqual([1, 0]);
    });

    it('stop ends a registered sink session', async () => {
      await ipc.start();
      const fake = fakeSink();
      ipc.register('m1', fake);
      await ipc.stop();
      expect(fake.ended).toBe(1);
    });

    it('buildStatusResponse lists a sink session', () => {
      ipc.register('m1', fakeSink());
      expect(ipc.buildStatusResponse().sessions.map((s: any) => s.sessionId)).toEqual(['m1']);
    });

    describe('socketSink', () => {
      it('writes one NDJSON line', () => {
        const socket = { writable: true, write: vi.fn(), end: vi.fn() } as any;
        socketSink(socket).send({ a: 1 });
        expect(socket.write).toHaveBeenCalledWith('{"a":1}\n');
      });

      it('writes nothing when the socket is not writable', () => {
        const socket = { writable: false, write: vi.fn(), end: vi.fn() } as any;
        socketSink(socket).send({ a: 1 });
        expect(socket.write).not.toHaveBeenCalled();
      });

      it('end ends the socket', () => {
        const socket = { writable: true, write: vi.fn(), end: vi.fn() } as any;
        socketSink(socket).end();
        expect(socket.end).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('engine port link (E2a)', () => {
    const ports: MessagePort[] = [];
    const settle = () => new Promise((r) => setTimeout(r, 20));

    /** Real MessageChannel: attachEnginePort on the main end, the real PortLinkRouter on the worker end. */
    function portRig(hooks: EnginePortHooks = {}) {
      const { port1: mainEnd, port2: workerEnd } = new MessageChannel();
      ports.push(mainEnd, workerEnd);
      const router = new PortLinkRouter(workerEnd);
      const seen: MainToWorker[] = [];
      const fromWorker: WorkerToMain[] = [];
      workerEnd.on('message', (m: MainToWorker) => { seen.push(m); router.handle(m); });
      const attached = attachEnginePort(mainEnd, ipc, hooks);
      return { router, seen, fromWorker, workerEnd, attached };
    }

    afterEach(() => { for (const p of ports.splice(0)) p.close(); });

    it('the same id over a socket then a port: the port start() rejects', async () => {
      await ipc.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'dup' });
      await readLine(client);
      const { router } = portRig();

      await expect(router.open('dup')).rejects.toThrow('"dup" is already in use');
      expect(sessions.count).toBe(1);
      client.end();
    });

    it('the same id over a port then a socket: the socket gets session_reject', async () => {
      await ipc.start();
      const { router } = portRig();
      await router.open('dup');

      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'dup' });
      const reject = await readLine(client);

      expect(reject.type).toBe('session_reject');
      client.end();
    });

    it('link close sends sessionDisconnect with closeTabIds and fires the count hook', async () => {
      const counts: number[] = [];
      ipc.setSessionCountCallback((n) => counts.push(n));
      const { router } = portRig();
      const link = await router.open('p1');
      sessions.addCreatedTab('p1', 7);

      await link.stop();
      await settle();

      expect(bridge.sendCmd).toHaveBeenCalledWith('sessionDisconnect', { sessionId: 'p1', closeTabIds: [7] }, 5000);
      expect(sessions.has('p1')).toBe(false);
      expect(counts).toEqual([1, 0]);
    });

    it('IPCServer.stop() ends port sinks and closes their sessions, like the socket path', async () => {
      await ipc.start();
      const { router } = portRig();
      await router.open('p1');
      expect(sessions.count).toBe(1);

      await ipc.stop();
      await settle();

      expect(sessions.count).toBe(0);
    });

    it('the port sink gets objects, with config_drift and peers', async () => {
      const { router, seen } = portRig();
      ipc.setConfigDrift(true);
      const link = await router.open('p1');

      const ackMsg = (seen.find((m) => m.t === 'msg') as Extract<MainToWorker, { t: 'msg' }>).msg;
      expect(typeof ackMsg).toBe('object');
      expect(ackMsg.type).toBe('session_ack');
      expect(ackMsg.config_drift).toBe(true);
      expect(ackMsg.peers).toEqual([]);
      expect(link.isConfigDrifted()).toBe(true);
    });

    it('a req round trip resolves through PortLink.sendCmd', async () => {
      const { router } = portRig();
      const link = await router.open('p1');

      const result = await link.sendCmd('experiments.getOne', { experiment: 'nope' });

      expect(result).toEqual({ experiment: 'nope', enabled: false });
    });

    it('status answers with buildStatusResponse', async () => {
      const { workerEnd } = portRig();
      const reply = new Promise<MainToWorker>((resolve) => workerEnd.once('message', resolve));
      workerEnd.postMessage({ t: 'status', rid: 5 } satisfies WorkerToMain);
      const res = await reply as Extract<MainToWorker, { t: 'status-res' }>;
      // uptimeSeconds moves with the clock between the two calls; compare the rest.
      const { uptimeSeconds, ...status } = res.status as any;
      const { uptimeSeconds: _later, ...expected } = JSON.parse(JSON.stringify(ipc.buildStatusResponse()));
      expect(typeof uptimeSeconds).toBe('number');
      expect(res).toMatchObject({ t: 'status-res', rid: 5 });
      expect(status).toEqual(expected);
    });

    it('env without a hook answers with an error', async () => {
      const { workerEnd } = portRig();
      const reply = new Promise<MainToWorker>((resolve) => workerEnd.once('message', resolve));
      workerEnd.postMessage({ t: 'env', rid: 1, cid: 'c', op: 'get', name: 'X' } satisfies WorkerToMain);
      const res = await reply as Extract<MainToWorker, { t: 'env-res' }>;
      expect(res.t).toBe('env-res');
      expect(res.rid).toBe(1);
      expect(res.error).toBeTruthy();
    });

    it('env with a hook answers with its value and keys, and a throwing hook answers an error', async () => {
      const env = vi.fn(async (_cid: string, op: 'get' | 'keys', name?: string) =>
        op === 'get' ? { value: `v-${name}` } : { keys: ['A', 'B'] });
      const { workerEnd } = portRig({ env });
      const next = () => new Promise<any>((resolve) => workerEnd.once('message', resolve));

      let p = next();
      workerEnd.postMessage({ t: 'env', rid: 1, cid: 'c1', op: 'get', name: 'X' } satisfies WorkerToMain);
      expect(await p).toEqual({ t: 'env-res', rid: 1, value: 'v-X' });
      expect(env).toHaveBeenCalledWith('c1', 'get', 'X');

      p = next();
      workerEnd.postMessage({ t: 'env', rid: 2, cid: 'c1', op: 'keys' } satisfies WorkerToMain);
      expect(await p).toEqual({ t: 'env-res', rid: 2, keys: ['A', 'B'] });

      env.mockRejectedValueOnce(new Error('shim gone'));
      p = next();
      workerEnd.postMessage({ t: 'env', rid: 3, cid: 'c1', op: 'get', name: 'X' } satisfies WorkerToMain);
      expect(await p).toEqual({ t: 'env-res', rid: 3, error: 'shim gone' });
    });

    it('ready, line and end go to the hooks; junk is ignored', async () => {
      const hooks = { ready: vi.fn(), line: vi.fn(), end: vi.fn() };
      const { workerEnd } = portRig(hooks);
      const buf = new TextEncoder().encode('{"a":1}');
      workerEnd.postMessage({ t: 'ready' } satisfies WorkerToMain);
      workerEnd.postMessage({ t: 'line', cid: 'c1', buf } satisfies WorkerToMain);
      workerEnd.postMessage({ t: 'end', cid: 'c1' } satisfies WorkerToMain);
      workerEnd.postMessage(null);
      workerEnd.postMessage('x');
      workerEnd.postMessage({ t: 'nope' });
      workerEnd.postMessage({ t: 'req', lid: 99, msg: {} });
      workerEnd.postMessage({ t: 'link-close', lid: 99 });
      await settle();

      expect(hooks.ready).toHaveBeenCalledTimes(1);
      expect(hooks.line).toHaveBeenCalledWith('c1', buf);
      expect(hooks.end).toHaveBeenCalledWith('c1');
    });

    it('detach closes every open link', async () => {
      const { router, attached } = portRig();
      await router.open('a');
      await router.open('b');
      sessions.addCreatedTab('a', 1);
      expect(sessions.count).toBe(2);

      attached.detach();

      expect(sessions.count).toBe(0);
      expect(bridge.sendCmd).toHaveBeenCalledWith('sessionDisconnect', { sessionId: 'a', closeTabIds: [1] }, 5000);
      expect(bridge.sendCmd).toHaveBeenCalledWith('sessionDisconnect', { sessionId: 'b', closeTabIds: [] }, 5000);
    });

    it('closing the port detaches', async () => {
      const { router, workerEnd } = portRig();
      await router.open('a');
      workerEnd.close();
      await settle();
      expect(sessions.count).toBe(0);
    });

    it('portSink posts msg and link-end without stringifying', () => {
      const port = { postMessage: vi.fn() };
      const sink = portSink(port, 4);
      sink.send({ a: 1 });
      sink.end();
      expect(port.postMessage).toHaveBeenNthCalledWith(1, { t: 'msg', lid: 4, msg: { a: 1 } });
      expect(port.postMessage).toHaveBeenNthCalledWith(2, { t: 'link-end', lid: 4 });
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

  describe('socket and shutdown hardening (M4)', () => {
    it('binds the socket mode 0600', async () => {
      // Short path: a sun_path over 107 bytes (a deep worktree) is silently truncated.
      const short = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ipcm-')), 's.sock');
      ipc = new IPCServer(short, bridge, sessions, scheduler, experiments, profileRegistry, { port: 5555, version: '9.9.9-test' });
      await ipc.start();
      expect(fs.statSync(short).mode & 0o777).toBe(0o600);
      await ipc.stop();
      fs.rmSync(path.dirname(short), { recursive: true, force: true });
    });

    it('stop() resolves within its deadline while an idle client stays connected', async () => {
      await ipc.start();
      const idle = await connectToSocket(sockPath); // never handshakes, never closes
      const t0 = Date.now();
      await ipc.stop();
      expect(Date.now() - t0).toBeLessThan(2000);
      idle.destroy();
    });

    it('stop() also ends a registered session that never closes its end', async () => {
      await ipc.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'quiet' });
      await readLine(client);
      const ended = new Promise<void>((r) => client.once('end', () => r()));
      const t0 = Date.now();
      await ipc.stop();
      expect(Date.now() - t0).toBeLessThan(400); // under the 500 ms destroy grace: end() did it
      await ended; // the server ended the session's socket
      client.destroy();
    });
  });

  describe('managed spawn waits for the extension pull (M4)', () => {
    it('holds profiles.connect until extensionReady settles, then reports the pull error', async () => {
      profileRegistry.create('dev');
      let settle!: () => void;
      const meta: IPCServerMeta = {
        port: 5555,
        version: '9.9.9-test',
        extensionPullError: null,
        extensionReady: new Promise<void>((r) => { settle = r; }),
      };
      ipc = new IPCServer(sockPath, bridge, sessions, scheduler, experiments, profileRegistry, meta);
      vi.mocked(isExtensionCached).mockReturnValue(false);
      await ipc.start();
      const client = await connectToSocket(sockPath);
      writeLine(client, { type: 'session_register', sessionId: 'sess-1' });
      await readLine(client);
      writeLine(client, { jsonrpc: '2.0', id: 'r1', method: 'profiles.connect', params: { profile: 'dev' } });

      let answered = false;
      const answer = readLine(client).then((r) => { answered = true; return r; });
      await new Promise((r) => setTimeout(r, 150));
      expect(answered).toBe(false);

      meta.extensionPullError = 'getaddrinfo ENOTFOUND api.github.com';
      settle();
      const res = await answer;
      expect(res.error.message).toMatch(/ENOTFOUND api\.github\.com/);
      client.end();
    });
  });

  describe('extension pull failure', () => {
    function makeIpcServer(metaOverrides: Partial<IPCServerMeta> = {}): IPCServer {
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
      vi.mocked(isExtensionCached).mockReturnValue(true);
    });

    it('fails profiles.connect with the pull error when the extension is not cached', async () => {
      ipc = makeIpcServer({
        extensionPullError: 'getaddrinfo ENOTFOUND api.github.com',
      });
      vi.mocked(isExtensionCached).mockReturnValue(false);

      await expect(
        callProfileMethod('sess-1', 'profiles.connect', { profile: 'dev' }, ipc),
      ).rejects.toThrow(/could not download the browser extension/i);
      // The guard must throw OUTSIDE the bootstrap queue, or a doomed spawn
      // serializes behind it. The mock runs its callback and propagates the
      // throw, so without this the ordering is untested.
      expect((bridge as any).matchmaker.enqueueBootstrap).not.toHaveBeenCalled();
    });

    it('names the underlying pull error so the user can act on it', async () => {
      ipc = makeIpcServer({
        extensionPullError: 'getaddrinfo ENOTFOUND api.github.com',
      });
      vi.mocked(isExtensionCached).mockReturnValue(false);

      await expect(
        callProfileMethod('sess-1', 'profiles.connect', { profile: 'dev' }, ipc),
      ).rejects.toThrow(/ENOTFOUND api\.github\.com/);
      expect((bridge as any).matchmaker.enqueueBootstrap).not.toHaveBeenCalled();
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
