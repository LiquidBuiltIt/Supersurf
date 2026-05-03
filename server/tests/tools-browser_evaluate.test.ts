import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onEvaluate } from '../src/tools/browser_evaluate';
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

describe('onEvaluate()', () => {
  const P = 'probing page state for custom case';

  // These tests exercise the IIFE wrapping + result serialization path,
  // not secure_eval. Disable secure_eval so calls reach `evaluate` directly
  // with the unwrapped expression we're asserting against.
  beforeEach(() => {
    process.env.SUPERSURF_DISABLE_SECURE_EVAL = '1';
  });

  afterEach(() => {
    delete process.env.SUPERSURF_DISABLE_SECURE_EVAL;
  });

  it('rejects when purpose is missing', async () => {
    const ctx = createMockCtx();
    await onEvaluate(ctx, { expression: '1+1' }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('purpose'), {});
    expect(ctx.ext.sendCmd).not.toHaveBeenCalled();
  });

  it('rejects when purpose is empty string', async () => {
    const ctx = createMockCtx();
    await onEvaluate(ctx, { expression: '1+1', purpose: '   ' }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('purpose'), {});
    expect(ctx.ext.sendCmd).not.toHaveBeenCalled();
  });

  it('forwards expression to extension', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue('42');
    const result = await onEvaluate(ctx, { expression: '1+1', purpose: P }, {});
    expect(result.content[0].text).toBe('42');
  });

  it('handles undefined result', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue(undefined);
    const result = await onEvaluate(ctx, { expression: 'void 0', purpose: P }, {});
    expect(result.content[0].text).toBe('undefined');
  });

  it('handles null result', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue(null);
    const result = await onEvaluate(ctx, { expression: 'null', purpose: P }, {});
    expect(result.content[0].text).toBe('null');
  });

  it('serializes object result', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue({ key: 'value' });
    const result = await onEvaluate(ctx, { expression: '({key:"value"})', purpose: P }, {});
    expect(result.content[0].text).toContain('"key"');
  });

  it('returns raw result', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue({ data: 123 });
    const result = await onEvaluate(ctx, { expression: 'test', purpose: P }, { rawResult: true });
    expect(result).toEqual({ data: 123 });
  });

  it('wraps function form as IIFE so it actually executes', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue(42);
    await onEvaluate(ctx, { function: '() => 42', purpose: P }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('evaluate', {
      expression: '(() => 42)()',
    });
  });

  it('wraps async function form as IIFE', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue('done');
    await onEvaluate(ctx, { function: 'async () => { return "done"; }', purpose: P }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('evaluate', {
      expression: '(async () => { return "done"; })()',
    });
  });
});
