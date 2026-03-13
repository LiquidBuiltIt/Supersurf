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

function mockBridge(): ExtensionBridge {
  return {
    sendCmd: vi.fn().mockResolvedValue({ success: true }),
    connected: true,
    browser: 'chrome',
    buildTime: '2026-01-01T00:00:00Z',
    notifyClientId: vi.fn(),
    onReconnect: null,
    onTabInfoUpdate: null,
    start: vi.fn(),
    stop: vi.fn(),
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
  let ipc: IPCServer;
  let sockPath: string;
  const baseDir = path.join(__dirname, '..', '.tmp-test');

  beforeEach(() => {
    // Use project-local tmp dir to avoid sandbox restrictions on Unix sockets
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(baseDir, 'ipc-'));
    sockPath = path.join(tmpDir, 'test.sock');

    bridge = mockBridge();
    sessions = new SessionRegistry();
    scheduler = new RequestScheduler(bridge, sessions);
    experiments = new DaemonExperimentRegistry();
    ipc = new IPCServer(sockPath, bridge, sessions, scheduler, experiments);
  });

  afterEach(async () => {
    await ipc.stop();
    try { fs.unlinkSync(sockPath); } catch {}
  });

  it('starts and accepts connections', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'test-session' });
    const response = await readLine(client);

    expect(response.type).toBe('session_ack');
    expect(response.browser).toBe('chrome');
    expect(response.buildTimestamp).toBe('2026-01-01T00:00:00Z');
    expect(response.capabilities).toEqual({ profiles: false });

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

  it('returns error for profile methods when profiles not enabled', async () => {
    await ipc.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'no-profiles' });
    await readLine(client);

    writeLine(client, {
      jsonrpc: '2.0',
      id: 'p-1',
      method: 'profiles.list',
      params: {},
    });

    const response = await readLine(client);
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain('not enabled');

    client.end();
  });

  it('includes capabilities.profiles in session_ack when registry provided', async () => {
    const profileTmpDir = fs.mkdtempSync(path.join(baseDir, 'profiles-'));
    const profileRegistry = new ProfileRegistry(profileTmpDir);
    const ipcWithProfiles = new IPCServer(
      sockPath, bridge, sessions, scheduler, experiments,
      { port: 5555, version: 'test' },
      profileRegistry,
    );

    await ipcWithProfiles.start();
    const client = await connectToSocket(sockPath);

    writeLine(client, { type: 'session_register', sessionId: 'cap-test' });
    const response = await readLine(client);

    expect(response.capabilities).toEqual({ profiles: true });

    client.end();
    await ipcWithProfiles.stop();
    fs.rmSync(profileTmpDir, { recursive: true, force: true });
  });

  it('handles profiles.create and profiles.list', async () => {
    const profileTmpDir = fs.mkdtempSync(path.join(baseDir, 'profiles-'));
    const profileRegistry = new ProfileRegistry(profileTmpDir);
    const ipcWithProfiles = new IPCServer(
      sockPath, bridge, sessions, scheduler, experiments,
      { port: 5555, version: 'test' },
      profileRegistry,
    );

    await ipcWithProfiles.start();
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
    await ipcWithProfiles.stop();
    fs.rmSync(profileTmpDir, { recursive: true, force: true });
  });

  it('handles profiles.delete', async () => {
    const profileTmpDir = fs.mkdtempSync(path.join(baseDir, 'profiles-'));
    const profileRegistry = new ProfileRegistry(profileTmpDir);
    const ipcWithProfiles = new IPCServer(
      sockPath, bridge, sessions, scheduler, experiments,
      { port: 5555, version: 'test' },
      profileRegistry,
    );

    await ipcWithProfiles.start();
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
    await ipcWithProfiles.stop();
    fs.rmSync(profileTmpDir, { recursive: true, force: true });
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
});
