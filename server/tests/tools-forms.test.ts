import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onFillForm, onDrag, onSecureFill } from '../src/tools/forms';
import type { ToolContext } from '../src/tools/types';

function createMockCtx(): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({}) } as any,
    connectionManager: null,
    cdp: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn().mockResolvedValue({ x: 100, y: 100 }),
    getSelectorExpression: vi.fn((s) => `document.querySelector("${s}")`),
    findAlternativeSelectors: vi.fn().mockResolvedValue([]),
    formatResult: vi.fn((_n, r) => ({ content: [{ type: 'text', text: JSON.stringify(r) }] })),
    error: vi.fn((msg) => ({ content: [{ type: 'text', text: msg }], isError: true })),
  };
}

describe('onFillForm()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('fills multiple form fields', async () => {
    const result = await onFillForm(ctx, {
      fields: [
        { selector: '#name', value: 'John' },
        { selector: '#email', value: 'john@test.com' },
      ],
    }, {});

    expect(ctx.eval).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toContain('#name');
    expect(result.content[0].text).toContain('#email');
  });

  it('returns raw result', async () => {
    const result = await onFillForm(ctx, {
      fields: [{ selector: '#name', value: 'John' }],
    }, { rawResult: true });

    expect(result.success).toBe(true);
    expect(result.fields).toHaveLength(1);
  });

  it('dispatches focus, InputEvent, change, and blur events', async () => {
    let evalCode = '';
    (ctx.eval as any).mockImplementation((code: string) => {
      evalCode = code;
      return Promise.resolve(undefined);
    });

    await onFillForm(ctx, {
      fields: [{ selector: '#name', value: 'John' }],
    }, {});

    // Should dispatch focus before setting value
    expect(evalCode).toContain("dispatchEvent(new Event('focus'");
    // Should use InputEvent for input event (React 17+ compatibility)
    expect(evalCode).toContain("new InputEvent('input'");
    // Should dispatch blur after change
    expect(evalCode).toContain("dispatchEvent(new Event('blur'");
    // Should have microtask yield before change
    expect(evalCode).toContain('Promise.resolve()');
  });

  it('uses native prototype setter for input elements', async () => {
    let evalCode = '';
    (ctx.eval as any).mockImplementation((code: string) => {
      evalCode = code;
      return Promise.resolve(undefined);
    });

    await onFillForm(ctx, {
      fields: [{ selector: '#email', value: 'test@test.com' }],
    }, {});

    // Should still use the native setter pattern
    expect(evalCode).toContain('Object.getOwnPropertyDescriptor(HTMLInputElement.prototype');
  });
});

describe('onDrag()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
    // Different centers for from and to
    (ctx.getElementCenter as any)
      .mockResolvedValueOnce({ x: 10, y: 10 })
      .mockResolvedValueOnce({ x: 200, y: 200 });
  });

  it('performs drag from source to target', async () => {
    const result = await onDrag(ctx, {
      fromSelector: '.source',
      toSelector: '.target',
    }, {});

    expect(ctx.getElementCenter).toHaveBeenCalledWith('.source');
    expect(ctx.getElementCenter).toHaveBeenCalledWith('.target');
    // mousePressed + 10 mouseMoved steps + mouseReleased + initial mouseMoved = 13 cdp calls
    expect(ctx.cdp).toHaveBeenCalledTimes(13);
    expect(result.content[0].text).toContain('.source');
    expect(result.content[0].text).toContain('.target');
  });

  it('returns raw result', async () => {
    (ctx.getElementCenter as any)
      .mockResolvedValueOnce({ x: 10, y: 10 })
      .mockResolvedValueOnce({ x: 200, y: 200 });

    const result = await onDrag(ctx, {
      fromSelector: '.a',
      toSelector: '.b',
    }, { rawResult: true });

    expect(result.success).toBe(true);
    expect(result.from).toEqual({ x: 10, y: 10 });
    expect(result.to).toEqual({ x: 200, y: 200 });
  });
});

describe('onSecureFill()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('fills credential from environment variable', async () => {
    process.env.TEST_SECRET = 'mypassword';
    const result = await onSecureFill(ctx, {
      action: 'fill',
      selector: '#password',
      credential_env: 'TEST_SECRET',
    }, {});

    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('secure_fill', {
      selector: '#password',
      value: 'mypassword',
    });
    expect(result.content[0].text).toContain('#password');
    expect(result.content[0].text).toContain('TEST_SECRET');
    // Value should NOT appear in output
    expect(result.content[0].text).not.toContain('mypassword');
    delete process.env.TEST_SECRET;
  });

  it('returns error when env var is not set', async () => {
    delete process.env.NONEXISTENT_VAR;
    await onSecureFill(ctx, {
      action: 'fill',
      selector: '#password',
      credential_env: 'NONEXISTENT_VAR',
    }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('not set'), expect.anything());
  });

  it('returns error when selector is missing', async () => {
    await onSecureFill(ctx, { action: 'fill', credential_env: 'SOME_VAR' }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('required'), expect.anything());
  });

  it('returns error when credential_env is missing', async () => {
    await onSecureFill(ctx, { action: 'fill', selector: '#pw' }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('required'), expect.anything());
  });

  it('returns raw result', async () => {
    process.env.TEST_RAW = 'secret';
    const result = await onSecureFill(ctx, {
      action: 'fill',
      selector: '#input',
      credential_env: 'TEST_RAW',
    }, { rawResult: true });

    expect(result.success).toBe(true);
    expect(result.credential_env).toBe('TEST_RAW');
    delete process.env.TEST_RAW;
  });

  it('lists available credentials', async () => {
    const result = await onSecureFill(ctx, { action: 'list' }, {});
    expect(result.content[0].text).toBeDefined();
  });

  it('lists available credentials in raw mode', async () => {
    const result = await onSecureFill(ctx, { action: 'list' }, { rawResult: true });
    expect(result.success).toBe(true);
    expect(Array.isArray(result.credentials)).toBe(true);
  });
});
