import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockChrome } from '../__mocks__/chrome';
import { WebSocketConnection } from '../../src/connection/websocket';

function createMockLogger() {
  return {
    log: vi.fn(),
    logAlways: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    setDebugMode: vi.fn(),
  } as any;
}

function createMockIconManager() {
  return {
    init: vi.fn(),
    setConnected: vi.fn(),
    setAttachedTab: vi.fn(),
    setStealthMode: vi.fn(),
    updateBadgeForTab: vi.fn(),
    updateBadge: vi.fn(),
    clearBadge: vi.fn(),
    setGlobalIcon: vi.fn().mockResolvedValue(undefined),
    updateConnectingBadge: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('WebSocketConnection', () => {
  let mockChrome: ReturnType<typeof createMockChrome>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockIconManager: ReturnType<typeof createMockIconManager>;
  let ws: WebSocketConnection;

  beforeEach(() => {
    mockChrome = createMockChrome();
    mockLogger = createMockLogger();
    mockIconManager = createMockIconManager();
    ws = new WebSocketConnection(mockChrome, mockLogger, mockIconManager, '2024-01-01T00:00:00Z');
  });

  describe('registerCommandHandler()', () => {
    it('stores handler in commandHandlers map', () => {
      const handler = vi.fn();
      ws.registerCommandHandler('test_command', handler);

      expect(ws.commandHandlers.get('test_command')).toBe(handler);
    });

    it('overwrites existing handler for the same method', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      ws.registerCommandHandler('cmd', handler1);
      ws.registerCommandHandler('cmd', handler2);

      expect(ws.commandHandlers.get('cmd')).toBe(handler2);
    });
  });

  describe('registerNotificationHandler()', () => {
    it('stores handler in notificationHandlers map', () => {
      const handler = vi.fn();
      ws.registerNotificationHandler('test_notification', handler);

      expect(ws.notificationHandlers.get('test_notification')).toBe(handler);
    });

    it('overwrites existing handler for the same method', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      ws.registerNotificationHandler('notif', handler1);
      ws.registerNotificationHandler('notif', handler2);

      expect(ws.notificationHandlers.get('notif')).toBe(handler2);
    });
  });

  describe('isExtensionEnabled()', () => {
    it('reads extensionEnabled from chrome.storage.local', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ extensionEnabled: true });

      const result = await ws.isExtensionEnabled();

      expect(mockChrome.storage.local.get).toHaveBeenCalledWith(['extensionEnabled']);
      expect(result).toBe(true);
    });

    it('returns true when extensionEnabled is not set (defaults to enabled)', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({});

      const result = await ws.isExtensionEnabled();
      expect(result).toBe(true);
    });

    it('returns false when extensionEnabled is explicitly false', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ extensionEnabled: false });

      const result = await ws.isExtensionEnabled();
      expect(result).toBe(false);
    });
  });

  describe('getConnectionUrl()', () => {
    it('builds correct URL from stored port', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ mcpPort: '8080' });

      const url = await ws.getConnectionUrl();
      expect(url).toBe('ws://127.0.0.1:8080/extension');
    });

    it('uses default port 5555 when no port is stored', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({});

      const url = await ws.getConnectionUrl();
      expect(url).toBe('ws://127.0.0.1:5555/extension');
    });

    it('logs the connection URL', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ mcpPort: '5555' });

      await ws.getConnectionUrl();
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('ws://127.0.0.1:5555/extension')
      );
    });
  });

  describe('disconnect()', () => {
    it('sets isConnected to false', () => {
      ws.isConnected = true;
      ws.disconnect();
      expect(ws.isConnected).toBe(false);
    });

    it('clears the socket reference', () => {
      // Simulate having a socket
      ws.socket = { close: vi.fn(), readyState: 1 } as any;
      ws.disconnect();
      expect(ws.socket).toBeNull();
    });

    it('calls socket.close() when socket exists', () => {
      const closeFn = vi.fn();
      ws.socket = { close: closeFn, readyState: 1 } as any;
      ws.disconnect();
      expect(closeFn).toHaveBeenCalled();
    });

    it('updates icon manager state', () => {
      ws.isConnected = true;
      ws.disconnect();

      expect(mockIconManager.setConnected).toHaveBeenCalledWith(false);
      expect(mockIconManager.setGlobalIcon).toHaveBeenCalledWith('normal', 'Disconnected');
    });

    it('clears the reconnect alarm', () => {
      ws.disconnect();
      expect(mockChrome.alarms.clear).toHaveBeenCalledWith('ws-reconnect');
    });

    it('sends statusChanged message via runtime', () => {
      ws.disconnect();
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'statusChanged' });
    });

    it('does not throw when socket is null', () => {
      ws.socket = null;
      expect(() => ws.disconnect()).not.toThrow();
    });
  });

  describe('send()', () => {
    it('serializes and sends when connected', () => {
      const sendFn = vi.fn();
      ws.socket = { send: sendFn, readyState: 1 } as any;
      ws.isConnected = true;

      ws.send({ jsonrpc: '2.0', method: 'test' });

      expect(sendFn).toHaveBeenCalledWith(JSON.stringify({ jsonrpc: '2.0', method: 'test' }));
    });

    it('logs error when not connected', () => {
      ws.socket = null;
      ws.isConnected = false;

      ws.send({ jsonrpc: '2.0', method: 'test' });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('not connected')
      );
    });

    it('logs error when socket exists but isConnected is false', () => {
      ws.socket = { send: vi.fn(), readyState: 1 } as any;
      ws.isConnected = false;

      ws.send({ jsonrpc: '2.0', method: 'test' });

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('sendNotification()', () => {
    it('sends a JSON-RPC notification when connected', () => {
      const sendFn = vi.fn();
      ws.socket = { send: sendFn, readyState: 1 } as any;
      ws.isConnected = true;

      ws.sendNotification('tab_updated', { tabId: 5 });

      const sent = JSON.parse(sendFn.mock.calls[0][0]);
      expect(sent).toEqual({
        jsonrpc: '2.0',
        method: 'tab_updated',
        params: { tabId: 5 },
      });
    });

    it('does not send when socket is null', () => {
      ws.socket = null;
      ws.isConnected = false;

      // Should not throw
      ws.sendNotification('test', {});

      // Logger.error should NOT be called for sendNotification — it silently returns
      // (unlike send() which logs an error)
    });

    it('does not send when not connected', () => {
      ws.socket = { send: vi.fn(), readyState: 1 } as any;
      ws.isConnected = false;

      ws.sendNotification('test', {});

      expect((ws.socket as any).send).not.toHaveBeenCalled();
    });
  });

  describe('handleReconnectAlarm()', () => {
    it('calls connect when disconnected', () => {
      ws.isConnected = false;
      // Mock connect to prevent actual WebSocket creation
      const connectSpy = vi.spyOn(ws, 'connect').mockResolvedValue(undefined);

      ws.handleReconnectAlarm();

      expect(connectSpy).toHaveBeenCalled();
    });

    it('does not call connect when already connected', () => {
      ws.isConnected = true;
      const connectSpy = vi.spyOn(ws, 'connect').mockResolvedValue(undefined);

      ws.handleReconnectAlarm();

      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('clears reconnectTimeout', () => {
      // Simulate a pending reconnect
      (ws as any).reconnectTimeout = -1;

      ws.isConnected = true;
      ws.handleReconnectAlarm();

      expect((ws as any).reconnectTimeout).toBeNull();
    });
  });

  describe('connect()', () => {
    // connect() creates a real WebSocket, so we mock the global WebSocket class

    let MockWebSocket: any;
    let mockSocketInstance: any;

    beforeEach(() => {
      mockSocketInstance = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      };
      MockWebSocket = vi.fn().mockImplementation(function(this: any) {
        Object.assign(this, mockSocketInstance);
        return this;
      });
      MockWebSocket.CONNECTING = 0;
      MockWebSocket.OPEN = 1;
      MockWebSocket.CLOSING = 2;
      MockWebSocket.CLOSED = 3;
      (globalThis as any).WebSocket = MockWebSocket;
    });

    it('creates a WebSocket with the correct URL', async () => {
      mockChrome.storage.local.get
        .mockResolvedValueOnce({ extensionEnabled: true })  // isExtensionEnabled
        .mockResolvedValueOnce({ mcpPort: '5555' });        // getConnectionUrl

      await ws.connect();

      expect(MockWebSocket).toHaveBeenCalledWith('ws://127.0.0.1:5555/extension');
    });

    it('does not connect when extension is disabled', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ extensionEnabled: false });

      await ws.connect();

      expect(MockWebSocket).not.toHaveBeenCalled();
    });

    it('does not create duplicate connections when already connecting', async () => {
      const mockSocket = {
        readyState: 0, // CONNECTING
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      };
      ws.socket = mockSocket as any;

      await ws.connect();

      expect(MockWebSocket).not.toHaveBeenCalled();
    });

    it('does not create duplicate connections when already open', async () => {
      const mockSocket = {
        readyState: 1, // OPEN
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        close: vi.fn(),
        send: vi.fn(),
      };
      ws.socket = mockSocket as any;

      await ws.connect();

      expect(MockWebSocket).not.toHaveBeenCalled();
    });

    it('cleans up old socket before creating new one', async () => {
      const oldClose = vi.fn();
      const oldSocket = {
        readyState: 3, // CLOSED
        close: oldClose,
      };
      ws.socket = oldSocket as any;

      mockChrome.storage.local.get
        .mockResolvedValueOnce({ extensionEnabled: true })
        .mockResolvedValueOnce({ mcpPort: '5555' });

      await ws.connect();

      expect(oldClose).toHaveBeenCalled();
      expect(MockWebSocket).toHaveBeenCalled();
    });

    it('updates icon to connecting state', async () => {
      mockChrome.storage.local.get
        .mockResolvedValueOnce({ extensionEnabled: true })
        .mockResolvedValueOnce({ mcpPort: '5555' });

      await ws.connect();

      expect(mockIconManager.updateConnectingBadge).toHaveBeenCalled();
    });

    it('sets event handlers on the new socket', async () => {
      mockChrome.storage.local.get
        .mockResolvedValueOnce({ extensionEnabled: true })
        .mockResolvedValueOnce({ mcpPort: '5555' });

      await ws.connect();

      expect(ws.socket).not.toBeNull();
      expect(ws.socket!.onopen).toBeTypeOf('function');
      expect(ws.socket!.onmessage).toBeTypeOf('function');
      expect(ws.socket!.onerror).toBeTypeOf('function');
      expect(ws.socket!.onclose).toBeTypeOf('function');
    });
  });

  describe('_handleOpen() profile handshake', () => {
    beforeEach(() => {
      // Simulate connection state
      ws.isConnected = true;
      ws.socket = {
        readyState: 1,
        send: vi.fn(),
        close: vi.fn(),
      } as any;
    });

    it('includes profile in handshake when storage has supersurf_profile', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ supersurf_profile: 'scraper' });

      // Call _handleOpen
      await (ws as any)._handleOpen();

      // Wait for the .then() chain
      await new Promise(r => setTimeout(r, 10));

      const sent = JSON.parse((ws.socket!.send as any).mock.calls[0][0]);
      expect(sent.type).toBe('handshake');
      expect(sent.profile).toBe('scraper');
    });

    it('omits profile in handshake when storage is empty', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({});

      await (ws as any)._handleOpen();
      await new Promise(r => setTimeout(r, 10));

      const sent = JSON.parse((ws.socket!.send as any).mock.calls[0][0]);
      expect(sent.type).toBe('handshake');
      expect(sent.profile).toBeUndefined();
    });

    it('sends handshake without profile on storage read failure', async () => {
      mockChrome.storage.local.get.mockRejectedValueOnce(new Error('storage error'));

      await (ws as any)._handleOpen();
      await new Promise(r => setTimeout(r, 10));

      const sent = JSON.parse((ws.socket!.send as any).mock.calls[0][0]);
      expect(sent.type).toBe('handshake');
      expect(sent.profile).toBeUndefined();
    });
  });

  describe('constructor', () => {
    it('stores the buildTimestamp', () => {
      const conn = new WebSocketConnection(
        mockChrome,
        mockLogger,
        mockIconManager,
        '2025-06-01T00:00:00Z'
      );
      expect(conn.buildTimestamp).toBe('2025-06-01T00:00:00Z');
    });

    it('defaults buildTimestamp to null', () => {
      const conn = new WebSocketConnection(mockChrome, mockLogger, mockIconManager);
      expect(conn.buildTimestamp).toBeNull();
    });

    it('starts with isConnected=false and socket=null', () => {
      expect(ws.isConnected).toBe(false);
      expect(ws.socket).toBeNull();
    });

    it('initializes empty handler maps', () => {
      expect(ws.commandHandlers.size).toBe(0);
      expect(ws.notificationHandlers.size).toBe(0);
    });
  });
});
