import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { Matchmaker } from '../../src/profiles/matchmaker';
import type { PooledConnection } from '../../src/profiles/types';

function mockWs(readyState = WebSocket.OPEN): WebSocket {
  return {
    readyState,
    send: vi.fn(),
    ping: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as any;
}

function mockConn(ws: WebSocket, profile: string | null = null): PooledConnection {
  return {
    ws,
    profile,
    browser: 'chrome',
    buildTimestamp: null,
    pingInterval: null,
    inflight: new Map(),
    keepBrowserOnSessionEnd: true,
    version: '3.4.0',
    versionStatus: 'ok',
    versionError: null,
  };
}

describe('Matchmaker', () => {
  let matchmaker: Matchmaker;

  beforeEach(() => {
    matchmaker = new Matchmaker();
  });

  afterEach(() => {
    matchmaker.shutdown();
  });

  describe('pool management', () => {
    it('adds and removes connections', () => {
      const ws = mockWs();
      const conn = mockConn(ws);

      matchmaker.addConnection(ws, conn);
      expect(matchmaker.poolSize).toBe(1);
      expect(matchmaker.hasConnections).toBe(true);

      matchmaker.removeConnection(ws);
      expect(matchmaker.poolSize).toBe(0);
      expect(matchmaker.hasConnections).toBe(false);
    });

    it('drains inflight on removeConnection', () => {
      const ws = mockWs();
      const conn = mockConn(ws);
      const reject = vi.fn();
      conn.inflight.set('req-1', { resolve: vi.fn(), reject });

      matchmaker.addConnection(ws, conn);
      matchmaker.removeConnection(ws);

      expect(reject).toHaveBeenCalledWith(expect.any(Error));
      expect(conn.inflight.size).toBe(0);
    });

    it('drains inflight with the version error when the guard closed the socket', () => {
      const ws = mockWs();
      const conn = mockConn(ws);
      conn.versionStatus = 'rejected';
      conn.versionError = 'Extension 2.0.0 is too old for daemon 3.4.0.';
      const reject = vi.fn();
      conn.inflight.set('req-1', { resolve: vi.fn(), reject });

      matchmaker.addConnection(ws, conn);
      matchmaker.removeConnection(ws);

      expect(reject).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Extension 2.0.0 is too old for daemon 3.4.0.' }),
      );
    });

    it('still uses the generic message when a healthy connection drops', () => {
      const ws = mockWs();
      const conn = mockConn(ws);
      const reject = vi.fn();
      conn.inflight.set('req-1', { resolve: vi.fn(), reject });

      matchmaker.addConnection(ws, conn);
      matchmaker.removeConnection(ws);

      expect(reject).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Extension disconnected' }),
      );
    });
  });

  describe('requestMatch', () => {
    it('returns immediate match for unmanaged (null profile)', async () => {
      const ws = mockWs();
      const conn = mockConn(ws, null);
      matchmaker.addConnection(ws, conn);

      const result = await matchmaker.requestMatch(null);
      expect(result).toBe(conn);
    });

    it('returns immediate match for named profile', async () => {
      const ws = mockWs();
      const conn = mockConn(ws, 'scraper');
      matchmaker.addConnection(ws, conn);

      const result = await matchmaker.requestMatch('scraper');
      expect(result).toBe(conn);
    });

    it('waits for connection when none available', async () => {
      const matchPromise = matchmaker.requestMatch('pending', 5000);

      // Simulate connection arriving after a delay
      setTimeout(() => {
        const ws = mockWs();
        const conn = mockConn(ws, 'pending');
        matchmaker.addConnection(ws, conn);
      }, 50);

      const result = await matchPromise;
      expect(result.profile).toBe('pending');
    });

    it('times out when no match arrives', async () => {
      await expect(matchmaker.requestMatch('missing', 100))
        .rejects.toThrow("No extension connection for profile 'missing' after");
    });
  });

  describe('poaching prevention', () => {
    it('blocks unmanaged match when pendingSpawns is non-empty', async () => {
      const ws = mockWs();
      const conn = mockConn(ws, null); // unmanaged connection
      matchmaker.addConnection(ws, conn);

      matchmaker.pendingSpawns.add('spawning-profile');

      // Should timeout because unmanaged matching is blocked
      await expect(matchmaker.requestMatch(null, 100))
        .rejects.toThrow();
    });

    it('allows unmanaged match when pendingSpawns is empty', async () => {
      const ws = mockWs();
      const conn = mockConn(ws, null);
      matchmaker.addConnection(ws, conn);

      const result = await matchmaker.requestMatch(null);
      expect(result).toBe(conn);
    });
  });

  describe('updateProfile', () => {
    it('moves connection from unmanaged to managed', async () => {
      const ws = mockWs();
      const conn = mockConn(ws, null);
      matchmaker.addConnection(ws, conn);

      // Initially can be matched as unmanaged
      expect(matchmaker.getConnectionForProfile(null)).toBe(conn);
      expect(matchmaker.getConnectionForProfile('scraper')).toBeNull();

      // Update profile
      matchmaker.updateProfile(ws, 'scraper');

      // Now matches as managed
      expect(matchmaker.getConnectionForProfile('scraper')).toBe(conn);
      expect(matchmaker.getConnectionForProfile(null)).toBeNull();
    });

    it('resolves pending match after profile update', async () => {
      const ws = mockWs();
      const conn = mockConn(ws, null);
      matchmaker.addConnection(ws, conn);

      // Request match for 'scraper' — no match yet
      const matchPromise = matchmaker.requestMatch('scraper', 5000);

      // Simulate profile announcement
      setTimeout(() => {
        matchmaker.updateProfile(ws, 'scraper');
      }, 50);

      const result = await matchPromise;
      expect(result.profile).toBe('scraper');
    });
  });

  describe('sendCmd', () => {
    it('sends JSON-RPC and resolves on response', async () => {
      const ws = mockWs();
      const conn = mockConn(ws);
      matchmaker.addConnection(ws, conn);

      const cmdPromise = matchmaker.sendCmd(conn, 'navigate', { url: 'https://example.com' });

      // Simulate response
      const sentMsg = JSON.parse((ws.send as any).mock.calls[0][0]);
      const resolve = conn.inflight.get(sentMsg.id)?.resolve;
      resolve?.({ success: true });

      const result = await cmdPromise;
      expect(result).toEqual({ success: true });
    });

    it('rejects when connection is not open', async () => {
      const ws = mockWs(WebSocket.CLOSED);
      const conn = mockConn(ws);

      await expect(matchmaker.sendCmd(conn, 'navigate', {}))
        .rejects.toThrow('not connected');
    });
  });

  describe('bootstrap queue', () => {
    it('serializes operations', async () => {
      const order: number[] = [];

      await Promise.all([
        matchmaker.enqueueBootstrap(async () => {
          await new Promise(r => setTimeout(r, 50));
          order.push(1);
        }),
        matchmaker.enqueueBootstrap(async () => {
          order.push(2);
        }),
      ]);

      expect(order).toEqual([1, 2]);
    });
  });

  describe('shutdown', () => {
    it('clears pool and pending matches', () => {
      const ws = mockWs();
      const conn = mockConn(ws);
      matchmaker.addConnection(ws, conn);

      matchmaker.shutdown();

      expect(matchmaker.poolSize).toBe(0);
      expect(ws.close).toHaveBeenCalled();
    });
  });

  describe('version gating', () => {
    it('does not hand out a connection whose version was rejected', () => {
      const ws = mockWs();
      const conn = mockConn(ws, 'dev');
      conn.versionStatus = 'rejected';
      conn.versionError = 'nope';
      matchmaker.addConnection(ws, conn);

      expect(matchmaker.getConnectionForProfile('dev')).toBeNull();
    });

    it('does not hand out a connection whose handshake has not landed yet', () => {
      const ws = mockWs();
      const conn = mockConn(ws, 'dev');
      conn.versionStatus = 'pending';
      matchmaker.addConnection(ws, conn);

      expect(matchmaker.getConnectionForProfile('dev')).toBeNull();
    });

    it('hands out a connection with a patch-level warning', () => {
      const ws = mockWs();
      const conn = mockConn(ws, 'dev');
      conn.versionStatus = 'warn';
      conn.versionError = 'patch skew';
      matchmaker.addConnection(ws, conn);

      expect(matchmaker.getConnectionForProfile('dev')).toBe(conn);
    });

    it('gates the unmanaged slot the same way', () => {
      const ws = mockWs();
      const conn = mockConn(ws, null);
      conn.versionStatus = 'rejected';
      matchmaker.addConnection(ws, conn);

      expect(matchmaker.getConnectionForProfile(null)).toBeNull();
    });
  });

  describe('failPendingMatches', () => {
    it('rejects a waiting match with the given error instead of timing out', async () => {
      const promise = matchmaker.requestMatch('dev', 60000);
      const failed = matchmaker.failPendingMatches('dev', new Error('version mismatch'));

      expect(failed).toBe(1);
      await expect(promise).rejects.toThrow('version mismatch');
    });

    it('leaves matches for other profiles queued', async () => {
      const other = matchmaker.requestMatch('staging', 60000);
      matchmaker.requestMatch('dev', 60000).catch(() => {});

      expect(matchmaker.failPendingMatches('dev', new Error('boom'))).toBe(1);

      const ws = mockWs();
      matchmaker.addConnection(ws, mockConn(ws, 'staging'));
      await expect(other).resolves.toBeDefined();
    });

    it('returns 0 when nothing is waiting', () => {
      expect(matchmaker.failPendingMatches('dev', new Error('boom'))).toBe(0);
    });

    it('clears the pending timeout so shutdown does not double-reject', async () => {
      const promise = matchmaker.requestMatch('dev', 60000);
      matchmaker.failPendingMatches('dev', new Error('version mismatch'));
      await expect(promise).rejects.toThrow('version mismatch');

      matchmaker.shutdown();
      // No unhandled rejection, and the queue is empty.
      expect(matchmaker.failPendingMatches('dev', new Error('again'))).toBe(0);
    });
  });

  describe('recorded version rejection', () => {
    it('fails a later requestMatch immediately rather than waiting', async () => {
      matchmaker.recordVersionRejection({
        profile: 'dev',
        version: '2.9.0',
        message: 'Extension version 2.9.0 is not compatible',
      });

      await expect(matchmaker.requestMatch('dev', 60000)).rejects.toThrow(
        'Extension version 2.9.0 is not compatible',
      );
    });

    it('does not leak across profiles', async () => {
      matchmaker.recordVersionRejection({
        profile: 'dev',
        version: '2.9.0',
        message: 'bad dev',
      });

      const ws = mockWs();
      matchmaker.addConnection(ws, mockConn(ws, 'staging'));
      await expect(matchmaker.requestMatch('staging', 60000)).resolves.toBeDefined();
    });

    it('is cleared by a healthy handshake for the same profile', async () => {
      matchmaker.recordVersionRejection({ profile: 'dev', version: '2.9.0', message: 'bad' });
      matchmaker.clearVersionRejection('dev');

      const ws = mockWs();
      matchmaker.addConnection(ws, mockConn(ws, 'dev'));
      await expect(matchmaker.requestMatch('dev', 60000)).resolves.toBeDefined();
    });

    it('records the unmanaged slot under the null profile', async () => {
      matchmaker.recordVersionRejection({ profile: null, version: '2.9.0', message: 'bad wild' });
      await expect(matchmaker.requestMatch(null, 60000)).rejects.toThrow('bad wild');
    });

    it('lastVersionRejection reports the unmanaged slot', () => {
      matchmaker.recordVersionRejection({ profile: null, version: '2.9.0', message: 'bad wild' });
      expect(matchmaker.lastVersionRejection?.message).toBe('bad wild');
    });

    it('lastVersionRejection does not leak a managed profile rejection', () => {
      // A rejection on profile 'dev' must never surface to a session that is
      // not bound to 'dev'. session_ack is emitted before any profile binding.
      matchmaker.recordVersionRejection({ profile: 'dev', version: '2.9.0', message: 'bad dev' });
      expect(matchmaker.lastVersionRejection).toBeNull();
    });

    it('shutdown clears recorded rejections', async () => {
      matchmaker.recordVersionRejection({ profile: 'dev', version: '2.9.0', message: 'bad' });
      matchmaker.shutdown();
      expect(matchmaker.getVersionRejection('dev')).toBeNull();
    });
  });
});
