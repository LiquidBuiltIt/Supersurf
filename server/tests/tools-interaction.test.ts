import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onInteract } from '../src/tools/interaction';
import type { ToolContext } from '../src/tools/types';

// Mock experimental registry
vi.mock('../src/experimental/index', () => ({
  experimentRegistry: {
    isEnabled: vi.fn().mockReturnValue(false),
  },
  diffSnapshots: vi.fn().mockReturnValue({ added: [], removed: [], countDelta: 0 }),
  calculateConfidence: vi.fn().mockReturnValue(1.0),
  formatDiffSection: vi.fn().mockReturnValue(''),
}));

function createMockCtx(): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({}) } as any,
    connectionManager: null,
    cdp: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn().mockResolvedValue({ x: 50, y: 50 }),
    getSelectorExpression: vi.fn((s) => `document.querySelector("${s}")`),
    findAlternativeSelectors: vi.fn().mockResolvedValue([]),
    formatResult: vi.fn((_n, r) => ({ content: [{ type: 'text', text: JSON.stringify(r) }] })),
    error: vi.fn((msg) => ({ content: [{ type: 'text', text: msg }], isError: true })),
  };
}

describe('onInteract()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockCtx();
  });

  // ── Click ──

  it('handles click by selector', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'click', selector: '#btn' }],
    }, {});

    expect(ctx.getElementCenter).toHaveBeenCalledWith('#btn');
    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseMoved' }));
    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }));
    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased' }));
    // DOM-level click dispatched for navigation
    expect(ctx.eval).toHaveBeenCalledWith(expect.stringContaining('.click()'));
    expect(result.content[0].text).toContain('Clicked');
  });

  it('handles click by coordinates', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'click', x: 200, y: 300 }],
    }, {});

    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ x: 200, y: 300, type: 'mousePressed' }));
    // DOM-level click dispatched for navigation
    expect(ctx.eval).toHaveBeenCalledWith(expect.stringContaining('elementFromPoint(200, 300)'));
    expect(result.content[0].text).toContain('200, 300');
  });

  it('fails click without selector or coordinates', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'click' }],
    }, {});
    expect(result.content[0].text).toContain('✗');
    expect(result.isError).toBe(true);
  });

  // ── Type ──

  it('handles type action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'type', text: 'hello', selector: '#input' }],
    }, {});

    // Should dispatch 5 char events (h, e, l, l, o)
    expect(ctx.cdp).toHaveBeenCalledTimes(5);
    expect(result.content[0].text).toContain('Typed');
  });

  // ── Press key ──

  it('handles press_key action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'press_key', key: 'Enter' }],
    }, {});

    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyDown', key: 'Enter' }));
    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp' }));
    expect(result.content[0].text).toContain('Pressed Enter');
  });

  // ── Hover ──

  it('handles hover action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'hover', selector: '.menu' }],
    }, {});

    expect(ctx.getElementCenter).toHaveBeenCalledWith('.menu');
    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseMoved' }));
    expect(result.content[0].text).toContain('Hovered');
  });

  // ── Wait ──

  it('handles wait with timeout', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'wait', timeout: 500 }],
    }, {});

    expect(ctx.sleep).toHaveBeenCalledWith(500);
    expect(result.content[0].text).toContain('Waited 500ms');
  });

  it('handles wait with selector', async () => {
    (ctx.eval as any).mockResolvedValue(true);
    const result = await onInteract(ctx, {
      actions: [{ type: 'wait', selector: '#loader' }],
    }, {});

    expect(result.content[0].text).toContain('Element appeared');
  });

  // ── Mouse move ──

  it('handles mouse_move action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'mouse_move', x: 10, y: 20 }],
    }, {});

    expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ x: 10, y: 20 }));
    expect(result.content[0].text).toContain('Moved to');
  });

  // ── Scroll ──

  it('handles scroll_to action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'scroll_to', x: 0, y: 500 }],
    }, {});
    expect(result.content[0].text).toContain('Scrolled window to');
  });

  it('handles scroll_by action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'scroll_by', x: 0, y: 300 }],
    }, {});
    expect(result.content[0].text).toContain('Scrolled window by');
  });

  it('handles scroll_into_view action', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'scroll_into_view', selector: '#target' }],
    }, {});
    expect(result.content[0].text).toContain('Scrolled');
  });

  // ── Select custom dropdown ──

  it('handles select_custom by clicking trigger, waiting, then clicking option', async () => {
    // Mock eval to return the detected option text
    (ctx.eval as any)
      .mockResolvedValueOnce({ found: true, triggerSelector: '.my-select', triggerText: 'Choose...' }) // detect
      .mockResolvedValueOnce(undefined) // click trigger (DOM click)
      .mockResolvedValueOnce({ found: true, optionText: 'Engineering' }); // find & click option

    const result = await onInteract(ctx, {
      actions: [{ type: 'select_custom', selector: '.my-select', value: 'Engineering' }],
    }, {});

    expect(result.content[0].text).toContain('✓ select_custom');
    expect(result.content[0].text).toContain('Engineering');
    expect(ctx.eval).toHaveBeenCalled();
  });

  it('select_custom fails when no dropdown trigger found', async () => {
    (ctx.eval as any).mockResolvedValueOnce({ found: false });

    const result = await onInteract(ctx, {
      actions: [{ type: 'select_custom', selector: '.nonexistent', value: 'Foo' }],
    }, {});

    expect(result.content[0].text).toContain('✗ select_custom');
  });

  it('select_custom fails when option not found in listbox', async () => {
    (ctx.eval as any)
      .mockResolvedValueOnce({ found: true, triggerSelector: '.my-select', triggerText: 'Choose...' })
      .mockResolvedValueOnce(undefined) // click trigger (DOM click)
      .mockResolvedValueOnce({ found: false, available: ['Design', 'Marketing'] }); // option not found

    const result = await onInteract(ctx, {
      actions: [{ type: 'select_custom', selector: '.my-select', value: 'Engineering' }],
    }, {});

    expect(result.content[0].text).toContain('✗ select_custom');
    expect(result.content[0].text).toContain('not found');
  });

  // ── Unknown action ──

  it('fails on unknown action type', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'teleport' }],
    }, {});
    expect(result.content[0].text).toContain('✗');
    expect(result.content[0].text).toContain('Unknown action type');
  });

  // ── Multiple actions ──

  it('executes multiple actions in sequence', async () => {
    const result = await onInteract(ctx, {
      actions: [
        { type: 'click', x: 10, y: 10 },
        { type: 'press_key', key: 'Tab' },
      ],
    }, {});

    expect(result.content[0].text).toContain('Clicked');
    expect(result.content[0].text).toContain('Pressed Tab');
  });

  // ── onError behavior ──

  it('stops on first error by default', async () => {
    const result = await onInteract(ctx, {
      actions: [
        { type: 'click' }, // will fail — no selector or coords
        { type: 'press_key', key: 'Enter' }, // should not run
      ],
    }, {});

    expect(result.content[0].text).toContain('✗ click');
    expect(result.content[0].text).not.toContain('Pressed');
  });

  it('continues on error when onError=ignore', async () => {
    const result = await onInteract(ctx, {
      actions: [
        { type: 'click' }, // fails
        { type: 'press_key', key: 'Enter' },
      ],
      onError: 'ignore',
    }, {});

    expect(result.content[0].text).toContain('✗ click');
    expect(result.content[0].text).toContain('Pressed Enter');
  });

  // ── rawResult mode ──

  it('returns raw result format', async () => {
    const result = await onInteract(ctx, {
      actions: [{ type: 'press_key', key: 'Escape' }],
    }, { rawResult: true });

    expect(result.success).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toContain('Pressed Escape');
  });

  // ── Tab spawn detection ──

  it('appends spawned tab info to click response', async () => {
    (ctx.ext.sendCmd as any).mockImplementation(async (cmd: string, params: any) => {
      if (cmd === 'drainSpawnedTabs') {
        return { tabs: [{ id: 42, index: 3, url: 'https://example.com', title: 'Example' }] };
      }
      return {};
    });

    const result = await onInteract(ctx, {
      actions: [{ type: 'click', selector: '#link' }],
    }, {});

    expect(result.content[0].text).toContain('New tab(s) opened');
    expect(result.content[0].text).toContain('https://example.com');
    expect(result.content[0].text).toContain('Example');
    expect(result.content[0].text).toContain("browser_tabs action='attach'");
  });

  it('returns normal click response when no tabs spawned', async () => {
    (ctx.ext.sendCmd as any).mockImplementation(async (cmd: string) => {
      if (cmd === 'drainSpawnedTabs') return { tabs: [] };
      return {};
    });

    const result = await onInteract(ctx, {
      actions: [{ type: 'click', x: 100, y: 200 }],
    }, {});

    expect(result.content[0].text).toContain('Clicked');
    expect(result.content[0].text).not.toContain('New tab(s) opened');
  });

  it('click still works when drainSpawnedTabs throws', async () => {
    (ctx.ext.sendCmd as any).mockImplementation(async (cmd: string) => {
      if (cmd === 'drainSpawnedTabs') throw new Error('timeout');
      return {};
    });

    const result = await onInteract(ctx, {
      actions: [{ type: 'click', selector: '#btn' }],
    }, {});

    expect(result.content[0].text).toContain('Clicked');
    expect(result.isError).toBeFalsy();
  });

  it('appends spawned tab info to mouse_click response', async () => {
    (ctx.ext.sendCmd as any).mockImplementation(async (cmd: string) => {
      if (cmd === 'drainSpawnedTabs') {
        return { tabs: [{ id: 10, index: 1, url: 'https://new.tab', title: 'New' }] };
      }
      return {};
    });

    const result = await onInteract(ctx, {
      actions: [{ type: 'mouse_click', x: 50, y: 60 }],
    }, {});

    expect(result.content[0].text).toContain('New tab(s) opened');
    expect(result.content[0].text).toContain('https://new.tab');
  });

  // ── Scroll-aware page diffing ──

  it('uses viewport capture mode for scroll-only batches', async () => {
    const { experimentRegistry } = await import('../src/experimental/index');
    (experimentRegistry.isEnabled as any).mockReturnValue(true);

    await onInteract(ctx, {
      actions: [{ type: 'scroll_by', x: 0, y: 500 }],
    }, {});

    // Both before and after captures should use viewport mode
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('capturePageState', { mode: 'viewport' });
  });

  it('uses document capture mode for mixed action batches', async () => {
    const { experimentRegistry } = await import('../src/experimental/index');
    (experimentRegistry.isEnabled as any).mockReturnValue(true);

    await onInteract(ctx, {
      actions: [
        { type: 'click', x: 10, y: 10 },
        { type: 'scroll_by', x: 0, y: 500 },
      ],
    }, {});

    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('capturePageState', { mode: 'document' });
  });

  it('sleeps 350ms before after-capture for scroll-only batches', async () => {
    const { experimentRegistry } = await import('../src/experimental/index');
    (experimentRegistry.isEnabled as any).mockReturnValue(true);

    await onInteract(ctx, {
      actions: [{ type: 'scroll_to', x: 0, y: 1000 }],
    }, {});

    // sleep(350) should be called for scroll settlement
    expect(ctx.sleep).toHaveBeenCalledWith(350);
  });
});
