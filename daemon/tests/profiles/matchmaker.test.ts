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
        .rejects.toThrow('timeout');
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
});
