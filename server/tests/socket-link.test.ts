import { describe, it, expect, vi, beforeEach } from 'vitest';

const queue = vi.hoisted(() => [] as any[]);
const ensureDaemon = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const stopDaemon = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('shared')>();
  return {
    ...actual,
    createLog: () => () => {},
    DaemonClient: vi.fn(function (this: any) {
      Object.assign(this, queue.shift());
    }),
  };
});
vi.mock('../src/daemon-spawn', () => ({
  ensureDaemon,
  stopDaemon,
  getSockPath: vi.fn().mockReturnValue('/tmp/test-daemon.sock'),
}));

import { openSocketLink } from '../src/socket-link';
import { isVersionMismatch } from 'shared';

function client(over: Record<string, unknown> = {}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    version: '4.1.0',
    activeSessionCount: 1,
    ...over,
  };
}

const OPTS = { clientId: 'agent-1', port: 5555, debug: false, experiments: ['fingerprinting'], serverVersion: '4.1.0', guardVersion: true };

beforeEach(() => {
  queue.length = 0;
  ensureDaemon.mockClear();
  stopDaemon.mockClear();
});

describe('openSocketLink', () => {
  it('ensures the daemon, starts the client and returns it when versions match', async () => {
    const c = client();
    queue.push(c);
    const link = await openSocketLink(OPTS);
    expect(ensureDaemon).toHaveBeenCalledWith(5555, false, ['fingerprinting']);
    expect(c.start).toHaveBeenCalledOnce();
    expect(link).toMatchObject({ version: '4.1.0' });
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('guardVersion false returns the client without a version check', async () => {
    queue.push(client({ version: '0.0.1' }));
    const link = await openSocketLink({ ...OPTS, guardVersion: false });
    expect(link).toMatchObject({ version: '0.0.1' });
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('guardVersion false stops the client when start() rejects, then rethrows', async () => {
    const c = client({ start: vi.fn().mockRejectedValue(new Error('boom')) });
    queue.push(c);
    await expect(openSocketLink({ ...OPTS, guardVersion: false })).rejects.toThrow('boom');
    expect(c.stop).toHaveBeenCalledOnce();
  });

  it('guardVersion true does not stop the client when start() rejects', async () => {
    const c = client({ start: vi.fn().mockRejectedValue(new Error('boom')) });
    queue.push(c);
    await expect(openSocketLink(OPTS)).rejects.toThrow('boom');
    expect(c.stop).not.toHaveBeenCalled();
  });

  it('mismatch with one other session live: no restart, throws the "NOT restarted" reason', async () => {
    const c = client({ version: '4.0.0', activeSessionCount: 2 });
    queue.push(c);
    const err: any = await openSocketLink(OPTS).catch((e) => e);
    expect(isVersionMismatch(err)).toBe(true);
    expect(err.daemonVersion).toBe('4.0.0');
    expect(err.serverVersion).toBe('4.1.0');
    expect(err.reason).toBe(
      'The daemon was NOT restarted because 1 other session is currently active on it, and a restart would disconnect them.',
    );
    expect(c.stop).toHaveBeenCalledOnce();
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('mismatch with several other sessions uses the plural form', async () => {
    queue.push(client({ version: null, activeSessionCount: 3 }));
    const err: any = await openSocketLink(OPTS).catch((e) => e);
    expect(err.daemonVersion).toBeNull();
    expect(err.reason).toContain('2 other sessions are currently active on it');
  });

  it('mismatch with an unknown session count restarts the daemon once and reconnects', async () => {
    const first = client({ version: '4.0.0', activeSessionCount: null });
    const second = client({ version: '4.1.0' });
    queue.push(first, second);
    const link = await openSocketLink(OPTS);
    expect(first.stop).toHaveBeenCalled();
    expect(stopDaemon).toHaveBeenCalledOnce();
    expect(ensureDaemon).toHaveBeenCalledTimes(2);
    expect(second.start).toHaveBeenCalledOnce();
    expect(link).toMatchObject({ version: '4.1.0' });
  });

  it('still mismatched after the restart throws the "keeps respawning" reason', async () => {
    const first = client({ version: '4.0.0', activeSessionCount: null });
    const second = client({ version: '4.0.0', activeSessionCount: null });
    queue.push(first, second);
    const err: any = await openSocketLink(OPTS).catch((e) => e);
    expect(isVersionMismatch(err)).toBe(true);
    expect(err.reason).toBe('Something outside this server keeps respawning it.');
    expect(second.stop).toHaveBeenCalled();
  });
});
