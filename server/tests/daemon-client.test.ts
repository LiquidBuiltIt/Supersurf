import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DaemonClient } from '../src/daemon-client';

// Mock the logger
vi.mock('../src/logger', () => ({
  createLog: () => (..._args: unknown[]) => {},
}));

function createMockDaemon(sockPath: string, options: {
  ackResponse?: any;
  rejectReason?: string;
  onRequest?: (msg: any, socket: net.Socket) => void;
} = {}): net.Server {
  const server = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        const msg = JSON.parse(line);

        if (msg.type === 'session_register') {
          if (options.rejectReason) {
            socket.write(JSON.stringify({ type: 'session_reject', reason: options.rejectReason }) + '\n');
          } else {
            const ack = options.ackResponse || {
              type: 'session_ack',
              browser: 'chrome',
              buildTimestamp: '2026-01-01T00:00:00Z',
            };
            socket.write(JSON.stringify(ack) + '\n');
          }
        } else if (msg.jsonrpc === '2.0' && options.onRequest) {
          options.onRequest(msg, socket);
        }
      }
    });
  });

  server.listen(sockPath);
  return server;
}

describe('DaemonClient', () => {
  let sockPath: string;
  let tmpDir: string;
  let mockDaemon: net.Server | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-'));
    sockPath = path.join(tmpDir, 'daemon.sock');
  });

  afterEach(async () => {
    if (mockDaemon) {
      mockDaemon.close();
      mockDaemon = null;
    }
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  describe('start()', () => {
    it('connects and completes handshake', async () => {
      mockDaemon = createMockDaemon(sockPath);
      await new Promise(r => mockDaemon!.on('listening', r));

      const client = new DaemonClient(sockPath, 'test-session');
      await client.start();

      expect(client.connected).toBe(true);
      expect(client.browser).toBe('chrome');
      expect(client.buildTime).toBe('2026-01-01T00:00:00Z');

      await client.stop();
    });

    it('rejects when daemon rejects session', async () => {
      mockDaemon = createMockDaemon(sockPath, { rejectReason: 'ID taken' });
      await new Promise(r => mockDaemon!.on('listening', r));

      const client = new DaemonClient(sockPath, 'taken');
      await expect(client.start()).rejects.toThrow('ID taken');
    });

    it('rejects on connection error', async () => {
      const client = new DaemonClient('/nonexistent/path.sock', 'test');
      await expect(client.start()).rejects.toThrow();
    });
  });

  describe('sendCmd()', () => {
    it('sends JSON-RPC and receives response', async () => {
      mockDaemon = createMockDaemon(sockPath, {
        onRequest: (msg, socket) => {
          socket.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { navigated: true },
          }) + '\n');
        },
      });
      await new Promise(r => mockDaemon!.on('listening', r));

      const client = new DaemonClient(sockPath, 'test');
      await client.start();

      const result = await client.sendCmd('navigate', { url: 'https://example.com' });
      expect(result).toEqual({ navigated: true });

      await client.stop();
    });

    it('handles error responses', async () => {
      mockDaemon = createMockDaemon(sockPath, {
        onRequest: (msg, socket) => {
          socket.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'Tab not found' },
          }) + '\n');
        },
      });
      await new Promise(r => mockDaemon!.on('listening', r));

      const client = new DaemonClient(sockPath, 'test');
      await client.start();

      await expect(client.sendCmd('selectTab', { index: 999 })).rejects.toThrow('Tab not found');

      await client.stop();
    });

    it('throws when not connected', async () => {
      const client = new DaemonClient(sockPath, 'test');
      await expect(client.sendCmd('navigate', {})).rejects.toThrow('Not connected');
    });

    it('times out on no response', async () => {
      mockDaemon = createMockDaemon(sockPath, {
        onRequest: () => {
          // Intentionally don't respond
        },
      });
      await new Promise(r => mockDaemon!.on('listening', r));

      const client = new DaemonClient(sockPath, 'test');
      await client.start();

      await expect(
        client.sendCmd('slow', {}, 100) // 100ms timeout
      ).rejects.toThrow('timeout');

      await client.stop();
    });
  });

  describe('stop()', () => {
    it('disconnects gracefully', async () => {
      mockDaemon = createMockDaemon(sockPath);
      await new Promise(r => mockDaemon!.on('listening', r));

      const client = new DaemonClient(sockPath, 'test');
      await client.start();
      expect(client.connected).toBe(true);

      await client.stop();
      expect(client.connected).toBe(false);
    });

    it('drains inflight requests', async () => {
      mockDaemon = createMockDaemon(sockPath, {
        onRequest: () => {
          // Don't respond — will be drained on stop
        },
      });
      await new Promise(r => mockDaemon!.on('listening', r));

      const client = new DaemonClient(sockPath, 'test');
      await client.start();

      const promise = client.sendCmd('slow', {}, 30000);
      await client.stop();

      await expect(promise).rejects.toThrow('closed');
    });
  });

  describe('notifyClientId()', () => {
    it('is a no-op (daemon handles auth)', async () => {
      mockDaemon = createMockDaemon(sockPath);
      await new Promise(r => mockDaemon!.on('listening', r));

      const client = new DaemonClient(sockPath, 'test');
      await client.start();

      // Should not throw
      client.notifyClientId('my-project');

      await client.stop();
    });
  });
});
