import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockChrome } from '../__mocks__/chrome';
import { SessionContext } from '../../src/session-context';
import { registerMouseHandlers, handleIdleDrift } from '../../src/experimental/mouse-humanization';

// Mock chrome global for the module
const mockChrome = createMockChrome();
(globalThis as any).chrome = mockChrome;

function createMockWsConnection() {
  const handlers = new Map<string, Function>();
  return {
    registerCommandHandler: vi.fn((name: string, handler: Function) => {
      handlers.set(name, handler);
    }),
    _getHandler: (name: string) => handlers.get(name),
    isConnected: true,
    sendNotification: vi.fn(),
  } as any;
}

function createMockCdp() {
  return vi.fn().mockImplementation(async (_tabId: number, method: string, params?: any) => {
    if (method === 'Runtime.evaluate') {
      return { result: { value: '{"width":1920,"height":1080}' } };
    }
    return {};
  });
}

describe('Mouse Humanization Extension Handlers', () => {
  let wsConnection: ReturnType<typeof createMockWsConnection>;
  let sessionContext: SessionContext;
  let mockCdp: ReturnType<typeof createMockCdp>;

  beforeEach(() => {
    vi.clearAllMocks();
    wsConnection = createMockWsConnection();
    sessionContext = new SessionContext();
    sessionContext.getSession().attachedTabId = 42;
    mockCdp = createMockCdp();
    registerMouseHandlers(wsConnection, sessionContext, mockCdp);
  });

  describe('humanizedMouseMove', () => {
    it('registers the handler', () => {
      expect(wsConnection.registerCommandHandler).toHaveBeenCalledWith(
        'humanizedMouseMove',
        expect.any(Function)
      );
    });

    it('dispatches CDP mouseMoved for each waypoint', async () => {
      const handler = wsConnection._getHandler('humanizedMouseMove');
      const waypoints = [
        { x: 10, y: 20, delayMs: 0 },
        { x: 30, y: 40, delayMs: 0 },
        { x: 50, y: 60, delayMs: 0 },
      ];

      const result = await handler({ waypoints });

      expect(result.success).toBe(true);
      expect(result.waypointCount).toBe(3);
      expect(mockCdp).toHaveBeenCalledTimes(3);
      expect(mockCdp).toHaveBeenCalledWith(42, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: 10, y: 20,
      });
      expect(mockCdp).toHaveBeenCalledWith(42, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: 50, y: 60,
      });
    });

    it('updates cursor position to last waypoint', async () => {
      const handler = wsConnection._getHandler('humanizedMouseMove');
      await handler({
        waypoints: [
          { x: 100, y: 200, delayMs: 0 },
          { x: 300, y: 400, delayMs: 0 },
        ],
      });

      const pos = sessionContext.getSession().cursorPositions.get(42);
      expect(pos).toEqual({ x: 300, y: 400 });
    });

    it('returns early for empty waypoints', async () => {
      const handler = wsConnection._getHandler('humanizedMouseMove');
      const result = await handler({ waypoints: [] });

      expect(result.success).toBe(true);
      expect(result.waypointCount).toBe(0);
      expect(mockCdp).not.toHaveBeenCalled();
    });

    it('throws when no tab attached', async () => {
      sessionContext.getSession().attachedTabId = null;
      const handler = wsConnection._getHandler('humanizedMouseMove');

      await expect(handler({ waypoints: [{ x: 0, y: 0, delayMs: 0 }] }))
        .rejects.toThrow('No tab attached');
    });
  });

  describe('setHumanizationConfig', () => {
    it('registers the handler', () => {
      expect(wsConnection.registerCommandHandler).toHaveBeenCalledWith(
        'setHumanizationConfig',
        expect.any(Function)
      );
    });

    it('enables humanization and creates idle alarm', async () => {
      const handler = wsConnection._getHandler('setHumanizationConfig');
      const result = await handler({ enabled: true });

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(true);
      expect(sessionContext.getSession().humanizationConfig.enabled).toBe(true);
      expect(mockChrome.alarms.create).toHaveBeenCalledWith(
        'mouse-idle-drift',
        expect.objectContaining({ delayInMinutes: expect.any(Number) })
      );
    });

    it('disables humanization and clears idle alarm', async () => {
      const handler = wsConnection._getHandler('setHumanizationConfig');
      await handler({ enabled: true });

      mockChrome.alarms.create.mockClear();
      const result = await handler({ enabled: false });

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(false);
      expect(sessionContext.getSession().humanizationConfig.enabled).toBe(false);
      expect(mockChrome.alarms.clear).toHaveBeenCalledWith('mouse-idle-drift');
    });
  });

  describe('getViewportDimensions', () => {
    it('registers the handler', () => {
      expect(wsConnection.registerCommandHandler).toHaveBeenCalledWith(
        'getViewportDimensions',
        expect.any(Function)
      );
    });

    it('returns viewport dimensions from CDP', async () => {
      const handler = wsConnection._getHandler('getViewportDimensions');
      const result = await handler({});

      expect(result).toEqual({ width: 1920, height: 1080 });
      expect(mockCdp).toHaveBeenCalledWith(42, 'Runtime.evaluate', expect.objectContaining({
        expression: expect.stringContaining('innerWidth'),
      }));
    });

    it('returns fallback dimensions when CDP returns non-string', async () => {
      mockCdp.mockResolvedValueOnce({ result: { value: 42 } });
      const handler = wsConnection._getHandler('getViewportDimensions');
      const result = await handler({});

      expect(result).toEqual({ width: 1920, height: 1080 });
    });

    it('throws when no tab attached', async () => {
      sessionContext.getSession().attachedTabId = null;
      const handler = wsConnection._getHandler('getViewportDimensions');

      await expect(handler({})).rejects.toThrow('No tab attached');
    });
  });
});

describe('handleIdleDrift()', () => {
  let sessionContext: SessionContext;
  let mockCdp: ReturnType<typeof createMockCdp>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionContext = new SessionContext();
    mockCdp = createMockCdp();
  });

  it('does nothing when humanization is disabled', async () => {
    sessionContext.getSession().humanizationConfig = { enabled: false };
    await handleIdleDrift(sessionContext, mockCdp);
    expect(mockCdp).not.toHaveBeenCalled();
  });

  it('does nothing when no tab is attached', async () => {
    sessionContext.getSession().humanizationConfig = { enabled: true };
    sessionContext.getSession().attachedTabId = null;
    await handleIdleDrift(sessionContext, mockCdp);
    expect(mockCdp).not.toHaveBeenCalled();
  });

  it('dispatches a small drift from current position', async () => {
    sessionContext.getSession().humanizationConfig = { enabled: true };
    sessionContext.getSession().attachedTabId = 42;
    sessionContext.getSession().cursorPositions.set(42, { x: 500, y: 300 });

    await handleIdleDrift(sessionContext, mockCdp);

    expect(mockCdp).toHaveBeenCalledWith(42, 'Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mouseMoved',
    }));

    // Verify the drift is small (within 5px)
    const call = mockCdp.mock.calls[0];
    const params = call[2];
    const dx = Math.abs(params.x - 500);
    const dy = Math.abs(params.y - 300);
    expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThanOrEqual(6); // 5px + rounding
  });

  it('updates cursor position after drift', async () => {
    sessionContext.getSession().humanizationConfig = { enabled: true };
    sessionContext.getSession().attachedTabId = 42;
    sessionContext.getSession().cursorPositions.set(42, { x: 500, y: 500 });

    await handleIdleDrift(sessionContext, mockCdp);

    // Verify CDP was called with coordinates from the drift
    const pos = sessionContext.getSession().cursorPositions.get(42);
    expect(pos).toBeDefined();
    // The new position should match what was dispatched to CDP
    const cdpCall = mockCdp.mock.calls[0];
    expect(pos!.x).toBe(cdpCall[2].x);
    expect(pos!.y).toBe(cdpCall[2].y);
  });

  it('schedules next drift alarm', async () => {
    sessionContext.getSession().humanizationConfig = { enabled: true };
    sessionContext.getSession().attachedTabId = 42;

    await handleIdleDrift(sessionContext, mockCdp);

    expect(mockChrome.alarms.create).toHaveBeenCalledWith(
      'mouse-idle-drift',
      expect.objectContaining({ delayInMinutes: expect.any(Number) })
    );
  });

  it('handles CDP failures gracefully', async () => {
    sessionContext.getSession().humanizationConfig = { enabled: true };
    sessionContext.getSession().attachedTabId = 42;
    mockCdp.mockRejectedValueOnce(new Error('Tab closed'));

    // Should not throw
    await handleIdleDrift(sessionContext, mockCdp);
  });
});
