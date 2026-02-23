import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExtensionServer } from '../src/bridge';
import WebSocket from 'ws';

// Mock the logger
vi.mock('../src/logger', () => ({
  getLogger: () => ({
    log: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  }),
  createLog: () => (..._args: unknown[]) => {},
}));

// Use a range of ports to avoid conflicts between test runs
let portCounter = 9100;
function nextPort(): number {
  return portCounter++;
}

/**
 * Helper: create a WebSocket client that connects to the server.
 * Returns the client and a promise that resolves when the connection opens.
 */
function connectClient(port: number): { ws: WebSocket; ready: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return { ws, ready };
}

describe('ExtensionServer (bridge)', () => {
  let server: ExtensionServer;
  let port: number;
  const clients: WebSocket[] = [];

  beforeEach(() => {
    port = nextPort();
    server = new ExtensionServer(port, '127.0.0.1');
  });

  afterEach(async () => {
    // Close all test clients
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN || c.readyState === WebSocket.CONNECTING) {
        c.close();
      }
    }
    clients.length = 0;

    // Stop the server
    await server.stop();
  });

  // ---- start / stop ----

  describe('start() and stop()', () => {
    it('starts HTTP + WebSocket server', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('stop() cleans up server', async () => {
      await server.start();
      await server.stop();

      // Connection should fail after stop
      await expect(
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}`);
          ws.on('open', () => {
            ws.close();
            reject(new Error('Should not have connected'));
          });
          ws.on('error', () => resolve());
        })
      ).resolves.toBeUndefined();
    });

    it('stop() is safe to call when not started', async () => {
      await expect(server.stop()).resolves.toBeUndefined();
    });
  });

  // ---- connected getter ----

  describe('connected', () => {
    it('returns false when no client connected', async () => {
      await server.start();
      expect(server.connected).toBe(false);
    });

    it('returns true when client is connected', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;

      await new Promise((r) => setTimeout(r, 50));
      expect(server.connected).toBe(true);
    });

    it('returns false after client disconnects', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      ws.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(server.connected).toBe(false);
    });
  });

  // ---- sendCmd ----

  describe('sendCmd()', () => {
    it('throws when not connected', async () => {
      await server.start();
      await expect(server.sendCmd('test_method')).rejects.toThrow('Extension not connected');
    });

    it('sends JSON-RPC and resolves on response', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method) {
          const response = {
            jsonrpc: '2.0',
            id: msg.id,
            result: { success: true, data: 'hello' },
          };
          ws.send(JSON.stringify(response));
        }
      });

      const result = await server.sendCmd('test_method', { foo: 'bar' });
      expect(result).toEqual({ success: true, data: 'hello' });
    });

    it('rejects on timeout', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      // Client does NOT respond — should timeout
      await expect(server.sendCmd('slow_method', {}, 200)).rejects.toThrow('Request timeout');
    });

    it('sends correct JSON-RPC 2.0 format', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      const receivedMessages: any[] = [];
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        receivedMessages.push(msg);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
      });

      await server.sendCmd('my_method', { key: 'val' });

      expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
      const sent = receivedMessages[0];
      expect(sent.jsonrpc).toBe('2.0');
      expect(sent.method).toBe('my_method');
      expect(sent.params).toEqual({ key: 'val' });
      expect(sent.id).toBeDefined();
    });

    it('rejects when response contains an error', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {},
            error: { code: -32000, message: 'Something broke' },
          })
        );
      });

      await expect(server.sendCmd('fail_method')).rejects.toThrow('Something broke');
    });
  });

  // ---- message handling ----

  describe('message handling', () => {
    it('handles handshake messages', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      ws.send(
        JSON.stringify({
          type: 'handshake',
          browser: 'firefox',
          buildTimestamp: '2026-01-15T10:00:00.000Z',
        })
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(server.buildTime).toBe('2026-01-15T10:00:00.000Z');
      expect(server.browser).toBe('firefox');
    });

    it('handles tab info update notifications', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      const tabInfoCallback = vi.fn();
      server.onTabInfoUpdate = tabInfoCallback;

      ws.send(
        JSON.stringify({
          method: 'notifications/tab_info_update',
          params: { currentTab: { id: 1, title: 'Test', url: 'https://example.com' } },
        })
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(tabInfoCallback).toHaveBeenCalledWith({
        id: 1,
        title: 'Test',
        url: 'https://example.com',
      });
    });

    it('handles responses with currentTab info', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      const tabInfoCallback = vi.fn();
      server.onTabInfoUpdate = tabInfoCallback;

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                success: true,
                currentTab: { id: 5, title: 'Response Tab', url: 'https://resp.com' },
              },
            })
          );
        }
      });

      await server.sendCmd('some_command');

      expect(tabInfoCallback).toHaveBeenCalledWith({
        id: 5,
        title: 'Response Tab',
        url: 'https://resp.com',
      });
    });
  });

  // ---- notifyClientId ----

  describe('notifyClientId()', () => {
    it('sends notification when connected', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      const receivedMessages: any[] = [];
      ws.on('message', (data) => {
        receivedMessages.push(JSON.parse(data.toString()));
      });

      server.notifyClientId('my-project');
      await new Promise((r) => setTimeout(r, 100));

      const notification = receivedMessages.find((m) => m.method === 'authenticated');
      expect(notification).toBeDefined();
      expect(notification.params.client_id).toBe('my-project');
    });

    it('does not throw when not connected', () => {
      expect(() => server.notifyClientId('my-project')).not.toThrow();
    });
  });

  // ---- buildTime getter ----

  describe('buildTime', () => {
    it('returns null before handshake', async () => {
      await server.start();
      expect(server.buildTime).toBeNull();
    });

    it('returns value from handshake', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      ws.send(JSON.stringify({ type: 'handshake', buildTimestamp: '2026-02-01T00:00:00Z' }));
      await new Promise((r) => setTimeout(r, 100));

      expect(server.buildTime).toBe('2026-02-01T00:00:00Z');
    });
  });

  // ---- Reconnection ----

  describe('reconnection handling', () => {
    it('fires onReconnect callback on new connection after previous', async () => {
      await server.start();

      const reconnectSpy = vi.fn();
      server.onReconnect = reconnectSpy;

      // First connection
      const { ws: ws1, ready: ready1 } = connectClient(port);
      clients.push(ws1);
      await ready1;
      await new Promise((r) => setTimeout(r, 50));

      ws1.close();

      // Connect ws2 right away, before the server's close handler clears socket
      const { ws: ws2, ready: ready2 } = connectClient(port);
      clients.push(ws2);
      await ready2;
      await new Promise((r) => setTimeout(r, 150));

      expect(reconnectSpy).toHaveBeenCalled();
    });

    it('drains inflight requests on client disconnect', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      // Client ignores all messages (no response)
      // Send a command that will be pending when we disconnect
      const cmdPromise = server.sendCmd('pending_method', {}, 30000);

      // Give time for the message to be sent
      await new Promise((r) => setTimeout(r, 50));

      // Disconnect client — inflight should be drained immediately
      ws.close();

      // Should reject with disconnect error, not timeout
      await expect(cmdPromise).rejects.toThrow('Extension disconnected');
    });

    it('drains multiple inflight requests on disconnect', async () => {
      await server.start();
      const { ws, ready } = connectClient(port);
      clients.push(ws);
      await ready;
      await new Promise((r) => setTimeout(r, 50));

      const cmd1 = server.sendCmd('method_a', {}, 30000);
      const cmd2 = server.sendCmd('method_b', {}, 30000);
      const cmd3 = server.sendCmd('method_c', {}, 30000);

      await new Promise((r) => setTimeout(r, 50));
      ws.close();

      const results = await Promise.allSettled([cmd1, cmd2, cmd3]);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
          expect(result.reason.message).toBe('Extension disconnected');
        }
      }
    });

    it('rejects duplicate connections when one is already open', async () => {
      await server.start();

      // First connection
      const { ws: ws1, ready: ready1 } = connectClient(port);
      clients.push(ws1);
      await ready1;
      await new Promise((r) => setTimeout(r, 50));

      // Second connection while first is still open
      const { ws: ws2, ready: ready2 } = connectClient(port);
      clients.push(ws2);
      await ready2;

      // ws2 should receive an error and get closed
      await new Promise<void>((resolve) => {
        ws2.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.error) {
            expect(msg.error.message).toContain('Another browser');
            resolve();
          }
        });
        // Fallback timeout
        setTimeout(resolve, 500);
      });
    });
  });
});
