import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  onWindow, onDialog,
  onVerifyTextVisible, onVerifyElementVisible,
  onListExtensions,
  onPerformanceMetrics,
} from '../src/tools/misc';
import type { ToolContext } from '../src/tools/lib/types';

function createMockCtx(): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({ success: true }) } as any,
    connectionManager: null,
    cdp: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn(),
    getSelectorExpression: vi.fn(),
    findAlternativeSelectors: vi.fn(),
    formatResult: vi.fn((_n, r) => ({ content: [{ type: 'text', text: JSON.stringify(r) }] })),
    error: vi.fn((msg) => ({ content: [{ type: 'text', text: msg }], isError: true })),
  };
}

describe('onWindow()', () => {
  it('forwards window action to extension', async () => {
    const ctx = createMockCtx();
    await onWindow(ctx, { action: 'maximize' }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('window', expect.objectContaining({ action: 'maximize' }));
    expect(ctx.formatResult).toHaveBeenCalled();
  });

  it('passes resize dimensions', async () => {
    const ctx = createMockCtx();
    await onWindow(ctx, { action: 'resize', width: 1920, height: 1080 }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('window', { action: 'resize', width: 1920, height: 1080 });
  });
});

describe('onDialog()', () => {
  it('accepts a dialog', async () => {
    const ctx = createMockCtx();
    await onDialog(ctx, { accept: true }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('dialog', { accept: true, text: undefined });
  });

  it('dismisses a dialog', async () => {
    const ctx = createMockCtx();
    await onDialog(ctx, { accept: false }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('dialog', { accept: false, text: undefined });
  });

  it('passes prompt text', async () => {
    const ctx = createMockCtx();
    await onDialog(ctx, { accept: true, text: 'answer' }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('dialog', { accept: true, text: 'answer' });
  });

  it('gets dialog state when no accept param', async () => {
    const ctx = createMockCtx();
    await onDialog(ctx, {}, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('dialog', {});
  });
});

describe('onDialog returns events on both code paths', () => {
  it('with accept: result includes events from the WS response', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue({
      events: [{ type: 'alert', message: 'hi', response: 'accepted', timestamp: 1 }],
    });
    (ctx.formatResult as any).mockImplementation((_name: string, result: any) => result);

    const out = await onDialog(ctx, { accept: true }, {});
    expect(out.events).toHaveLength(1);
  });

  it('with no accept: same shape', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue({
      events: [{ type: 'confirm', message: 'go?', response: 'dismissed', timestamp: 2 }],
    });
    (ctx.formatResult as any).mockImplementation((_name: string, result: any) => result);

    const out = await onDialog(ctx, {}, {});
    expect(out.events).toHaveLength(1);
  });
});

describe('onVerifyTextVisible()', () => {
  it('returns success when text is found', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue(true);
    const result = await onVerifyTextVisible(ctx, { text: 'Hello' }, {});
    expect(result.content[0].text).toContain('✓');
    expect(result.isError).toBeFalsy();
  });

  it('returns error when text is not found', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue(false);
    const result = await onVerifyTextVisible(ctx, { text: 'Missing' }, {});
    expect(result.content[0].text).toContain('✗');
    expect(result.isError).toBe(true);
  });

  it('returns raw result', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue(true);
    const result = await onVerifyTextVisible(ctx, { text: 'test' }, { rawResult: true });
    expect(result).toEqual({ visible: true, text: 'test' });
  });
});

describe('onVerifyElementVisible()', () => {
  it('returns success when element is visible', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue({ exists: true, visible: true });
    const result = await onVerifyElementVisible(ctx, { selector: '#btn' }, {});
    expect(result.content[0].text).toContain('✓');
  });

  it('returns error when element is not visible', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue({ exists: true, visible: false });
    const result = await onVerifyElementVisible(ctx, { selector: '#btn' }, {});
    expect(result.content[0].text).toContain('✗');
    expect(result.isError).toBe(true);
  });

  it('returns error when element does not exist', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue({ exists: false, visible: false });
    const result = await onVerifyElementVisible(ctx, { selector: '.missing' }, {});
    expect(result.isError).toBe(true);
  });
});

describe('onListExtensions()', () => {
  it('forwards to extension and formats result', async () => {
    const ctx = createMockCtx();
    await onListExtensions(ctx, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('listExtensions', {});
    expect(ctx.formatResult).toHaveBeenCalled();
  });
});

describe('onDialog action routing', () => {
  function makeCtx() {
    const sendCmd = vi.fn().mockResolvedValue({ dialog: null });
    const ctx: any = {
      ext: { sendCmd },
      formatResult: (_name: string, r: any) => r,
    };
    return { ctx, sendCmd };
  }

  it('passes action:view through to the dialog command', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, { action: 'view' }, {});
    expect(sendCmd).toHaveBeenCalledWith('dialog', { action: 'view', text: undefined });
  });

  it('passes action:accept with text', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, { action: 'accept', text: 'Alice' }, {});
    expect(sendCmd).toHaveBeenCalledWith('dialog', { action: 'accept', text: 'Alice' });
  });

  it('passes action:dismiss through', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, { action: 'dismiss' }, {});
    expect(sendCmd).toHaveBeenCalledWith('dialog', { action: 'dismiss', text: undefined });
  });

  it('legacy accept:true still works (no action)', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, { accept: true, text: 'x' }, {});
    expect(sendCmd).toHaveBeenCalledWith('dialog', { accept: true, text: 'x' });
  });

  it('no args sends an empty dialog command (view)', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, {}, {});
    expect(sendCmd).toHaveBeenCalledWith('dialog', {});
  });

  it('action wins over accept when both present', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, { action: 'dismiss', accept: true }, {});
    // action branch fires first; legacy accept is never consulted
    expect(sendCmd).toHaveBeenCalledWith('dialog', { action: 'dismiss', text: undefined });
  });
});

describe('onPerformanceMetrics()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('returns combined CDP and Web Vitals metrics', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      metrics: [{ name: 'JSHeapUsedSize', value: 1000000 }],
    });
    (ctx.eval as any).mockResolvedValue({
      ttfb: 50, fcp: 200, domContentLoaded: 500, load: 800,
    });

    const result = await onPerformanceMetrics(ctx, {});
    expect(result.content[0].text).toContain('TTFB');
    expect(result.content[0].text).toContain('FCP');
    expect(result.content[0].text).toContain('JSHeapUsedSize');
  });

  it('handles null vitals gracefully', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ metrics: [] });
    (ctx.eval as any).mockResolvedValue(null);

    const result = await onPerformanceMetrics(ctx, {});
    expect(result.content[0].text).toContain('Performance Metrics');
  });

  it('returns raw result', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ metrics: [{ name: 'Metric', value: 42 }] });
    (ctx.eval as any).mockResolvedValue({ ttfb: 10 });

    const result = await onPerformanceMetrics(ctx, { rawResult: true });
    expect(result.metrics).toHaveLength(1);
    expect(result.vitals.ttfb).toBe(10);
  });
});
