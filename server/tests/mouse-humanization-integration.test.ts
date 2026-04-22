import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onInteract } from '../src/tools/interaction';
import type { ToolContext } from '../src/tools/types';
import { experimentRegistry } from '../src/experimental/index';
import { initSession, destroySession } from '../src/experimental/mouse-humanization/index';

// Mock experimental registry to control test behavior
vi.mock('../src/experimental/index', async () => {
  const actual = await vi.importActual<typeof import('../src/experimental/index')>('../src/experimental/index');
  return {
    ...actual,
    experimentRegistry: {
      ...actual.experimentRegistry,
      isEnabled: vi.fn().mockReturnValue(false),
    },
    diffSnapshots: vi.fn().mockReturnValue({ added: [], removed: [], countDelta: 0 }),
    calculateConfidence: vi.fn().mockReturnValue(1.0),
    formatDiffSection: vi.fn().mockReturnValue(''),
  };
});

function createMockCtx(): ToolContext {
  return {
    ext: {
      sendCmd: vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'getViewportDimensions') {
          return Promise.resolve({ width: 1920, height: 1080 });
        }
        if (cmd === 'humanizedMouseMove') {
          return Promise.resolve({ success: true, waypointCount: 5 });
        }
        return Promise.resolve({});
      }),
    } as any,
    connectionManager: null,
    cdp: vi.fn().mockImplementation(async (method: string, params: any) => {
      if (method === 'Runtime.evaluate' && (params == null || params.contextId === undefined)) {
        return { result: { objectId: 'top-obj' } };
      }
      return {};
    }),
    eval: vi.fn().mockResolvedValue({ focused: true, scrolled: true, cleared: true, selected: true, optionText: 'ok', verified: true, found: true }),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn().mockResolvedValue({ x: 50, y: 50 }),
    getSelectorExpression: vi.fn((s) => `document.querySelector("${s}")`),
    findAlternativeSelectors: vi.fn().mockResolvedValue([]),
    formatResult: vi.fn((_n, r) => ({ content: [{ type: 'text', text: JSON.stringify(r) }] })),
    error: vi.fn((msg) => ({ content: [{ type: 'text', text: msg }], isError: true })),
  };
}

describe('interaction with mouse_humanization', () => {
  let ctx: ToolContext;
  const mockIsEnabled = experimentRegistry.isEnabled as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockCtx();
    // Default: humanization disabled
    mockIsEnabled.mockReturnValue(false);
  });

  describe('when mouse_humanization is disabled', () => {
    it('click sends direct CDP mouseMoved', async () => {
      await onInteract(ctx, {
        actions: [{ type: 'click', x: 200, y: 300 }],
      }, {});

      expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mouseMoved', x: 200, y: 300,
      }));
      expect(ctx.ext.sendCmd).not.toHaveBeenCalledWith('humanizedMouseMove', expect.anything());
    });

    it('hover sends direct CDP mouseMoved', async () => {
      await onInteract(ctx, {
        actions: [{ type: 'hover', selector: '.btn' }],
      }, {});

      expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mouseMoved',
      }));
    });

    it('mouse_move sends direct CDP mouseMoved', async () => {
      await onInteract(ctx, {
        actions: [{ type: 'mouse_move', x: 10, y: 20 }],
      }, {});

      expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mouseMoved', x: 10, y: 20,
      }));
    });
  });

  describe('when mouse_humanization is enabled', () => {
    beforeEach(() => {
      mockIsEnabled.mockImplementation((feature: string) => feature === 'mouse_humanization');
      initSession('_default');
    });

    afterEach(() => {
      destroySession('_default');
    });

    it('click sends humanizedMouseMove instead of direct CDP', async () => {
      await onInteract(ctx, {
        actions: [{ type: 'click', x: 200, y: 300 }],
      }, {});

      expect(ctx.ext.sendCmd).toHaveBeenCalledWith('getViewportDimensions', {});
      expect(ctx.ext.sendCmd).toHaveBeenCalledWith('humanizedMouseMove', expect.objectContaining({
        waypoints: expect.any(Array),
      }));
      // Still dispatches press/release via CDP
      expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mousePressed',
      }));
      expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mouseReleased',
      }));
    });

    it('hover sends humanizedMouseMove instead of direct CDP', async () => {
      await onInteract(ctx, {
        actions: [{ type: 'hover', selector: '.menu' }],
      }, {});

      expect(ctx.ext.sendCmd).toHaveBeenCalledWith('humanizedMouseMove', expect.objectContaining({
        waypoints: expect.any(Array),
      }));
    });

    it('mouse_move sends humanizedMouseMove', async () => {
      await onInteract(ctx, {
        actions: [{ type: 'mouse_move', x: 100, y: 200 }],
      }, {});

      expect(ctx.ext.sendCmd).toHaveBeenCalledWith('humanizedMouseMove', expect.objectContaining({
        waypoints: expect.any(Array),
      }));
    });

    it('mouse_click sends humanizedMouseMove for movement', async () => {
      await onInteract(ctx, {
        actions: [{ type: 'mouse_click', x: 400, y: 500 }],
      }, {});

      expect(ctx.ext.sendCmd).toHaveBeenCalledWith('humanizedMouseMove', expect.objectContaining({
        waypoints: expect.any(Array),
      }));
      expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({
        type: 'mousePressed', x: 400, y: 500,
      }));
    });
  });

  describe('regression: non-mouse actions unaffected', () => {
    beforeEach(() => {
      mockIsEnabled.mockImplementation((feature: string) => feature === 'mouse_humanization');
      initSession('_default');
    });

    afterEach(() => {
      destroySession('_default');
    });

    it('press_key still uses direct CDP', async () => {
      await onInteract(ctx, {
        actions: [{ type: 'press_key', key: 'Enter' }],
      }, {});

      expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({
        type: 'keyDown', key: 'Enter',
      }));
      expect(ctx.ext.sendCmd).not.toHaveBeenCalledWith('humanizedMouseMove', expect.anything());
    });

    it('type still uses direct CDP', async () => {
      await onInteract(ctx, {
        actions: [{ type: 'type', text: 'hi', selector: '#input' }],
      }, {});

      expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({
        type: 'char', text: 'h',
      }));
    });

    it('scroll_to is unaffected', async () => {
      await onInteract(ctx, {
        actions: [{ type: 'scroll_to', x: 0, y: 500 }],
      }, {});

      expect(ctx.ext.sendCmd).not.toHaveBeenCalledWith('humanizedMouseMove', expect.anything());
    });
  });
});

// Import afterEach from vitest
import { afterEach } from 'vitest';
