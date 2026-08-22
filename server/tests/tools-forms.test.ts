import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onFillForm, onDrag, onSecureFill } from '../src/tools/forms';
import { getToolSchemas } from '../src/tools/schemas';
import type { ToolContext } from '../src/tools/lib/types';

function createMockCtx(): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({}) } as any,
    connectionManager: null,
    // Default cdp mock simulates a top-frame happy path for resolveInFrames:
    // Runtime.evaluate returns an objectId so onFillForm proceeds past resolution.
    cdp: vi.fn().mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { objectId: 'top-frame-object-id' } });
      }
      return Promise.resolve({});
    }),
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
    (ctx.eval as any).mockResolvedValue({ verified: true, actual: 'x' });

    const result = await onFillForm(ctx, {
      fields: [
        { selector: '#name', value: 'John' },
        { selector: '#email', value: 'john@test.com' },
      ],
    }, {});

    // 2 fields × (mutation + read-back) = 4 eval calls
    expect(ctx.eval).toHaveBeenCalledTimes(4);
    expect(result.content[0].text).toContain('#name');
    expect(result.content[0].text).toContain('#email');
  });

  it('returns raw result', async () => {
    (ctx.eval as any).mockResolvedValue({ verified: true, actual: 'John' });

    const result = await onFillForm(ctx, {
      fields: [{ selector: '#name', value: 'John' }],
    }, { rawResult: true });

    expect(result.success).toBe(true);
    expect(result.fields).toHaveLength(1);
  });

  it('dispatches focus, Event, change, and blur events', async () => {
    const evalCalls: string[] = [];
    (ctx.eval as any).mockImplementation((code: string) => {
      evalCalls.push(code);
      // First call is mutation, second is read-back
      if (evalCalls.length === 1) return Promise.resolve(undefined);
      return Promise.resolve({ verified: true, actual: 'John' });
    });

    await onFillForm(ctx, {
      fields: [{ selector: '#name', value: 'John' }],
    }, {});

    const evalCode = evalCalls[0];

    // Should dispatch focus before setting value
    expect(evalCode).toContain("dispatchEvent(new Event('focus'");
    // Should use plain Event for input event (React value-tracker compatibility, facebook/react#10135)
    expect(evalCode).toContain("new Event('input'");
    // Should dispatch blur after change
    expect(evalCode).toContain("dispatchEvent(new Event('blur'");
    // Should have microtask yield before change
    expect(evalCode).toContain('Promise.resolve()');
  });

  it('uses native prototype setter for input elements', async () => {
    const evalCalls: string[] = [];
    (ctx.eval as any).mockImplementation((code: string) => {
      evalCalls.push(code);
      if (evalCalls.length === 1) return Promise.resolve(undefined);
      return Promise.resolve({ verified: true, actual: 'test@test.com' });
    });

    await onFillForm(ctx, {
      fields: [{ selector: '#email', value: 'test@test.com' }],
    }, {});

    // Should still use the native setter pattern (in the mutation eval)
    expect(evalCalls[0]).toContain('Object.getOwnPropertyDescriptor(HTMLInputElement.prototype');
  });

  it('escapes selectors containing single quotes (regression: ATS UUID-attribute selectors)', async () => {
    // Real selector pattern observed in audit logs: [id='uuid-with-dashes']
    // Previously, raw interpolation broke the JS template with
    // "SyntaxError: missing ) after argument list".
    const evalCalls: string[] = [];
    (ctx.eval as any).mockImplementation((code: string) => {
      evalCalls.push(code);
      if (evalCalls.length === 1) return Promise.resolve(undefined);
      return Promise.resolve({ verified: true, actual: 'jcrisptx@gmail.com' });
    });

    const tricky = "[id='0c54799f-3b5f-47f9-92cd-c67e6ad1c7e4']";
    await onFillForm(ctx, {
      fields: [{ selector: tricky, value: 'jcrisptx@gmail.com' }],
    }, {});

    // The generated JS must be parseable — no stray unescaped single quotes
    // closing the error string early. Validate by parsing all eval calls.
    for (const evalCode of evalCalls) {
      expect(() => new Function(evalCode)).not.toThrow();
    }
  });

  it('escapes values containing quotes, parens, and backticks', async () => {
    const evalCalls: string[] = [];
    (ctx.eval as any).mockImplementation((code: string) => {
      evalCalls.push(code);
      if (evalCalls.length === 1) return Promise.resolve(undefined);
      return Promise.resolve({ verified: true, actual: `O'Brien (he/him) \`code\`` });
    });

    await onFillForm(ctx, {
      fields: [{ selector: '#bio', value: `O'Brien (he/him) \`code\`` }],
    }, {});

    for (const evalCode of evalCalls) {
      expect(() => new Function(evalCode)).not.toThrow();
    }
  });

  describe('post-action validation', () => {
    it('returns ✓ when read-back value matches intended value', async () => {
      (ctx.eval as any)
        .mockResolvedValueOnce(undefined) // mutation eval
        .mockResolvedValueOnce({ verified: true, actual: 'John' }); // read-back eval

      const result = await onFillForm(ctx, {
        fields: [{ selector: '#name', value: 'John' }],
      }, {});

      expect(result.content[0].text).toContain('✓');
      expect(result.content[0].text).toContain('#name');
    });

    it('returns ⚠ when read-back value differs from intended', async () => {
      (ctx.eval as any)
        .mockResolvedValueOnce(undefined) // mutation eval
        .mockResolvedValueOnce({ verified: false, actual: '' }); // read-back: empty string

      const result = await onFillForm(ctx, {
        fields: [{ selector: '#name', value: 'John' }],
      }, {});

      expect(result.content[0].text).toContain('⚠');
      expect(result.content[0].text).toContain('unverified');
      expect(result.content[0].text).toContain('#name');
    });

    it('verifies each field independently in a multi-field fill', async () => {
      (ctx.eval as any)
        .mockResolvedValueOnce(undefined) // field 1 mutation
        .mockResolvedValueOnce({ verified: true, actual: 'John' }) // field 1 read-back
        .mockResolvedValueOnce(undefined) // field 2 mutation
        .mockResolvedValueOnce({ verified: false, actual: '' }); // field 2 read-back

      const result = await onFillForm(ctx, {
        fields: [
          { selector: '#name', value: 'John' },
          { selector: '#email', value: 'john@test.com' },
        ],
      }, {});

      expect(result.content[0].text).toContain('✓');
      expect(result.content[0].text).toContain('⚠');
    });
  });

  describe('fingerprint healing', () => {
    it('heals a stale field selector when the top frame and child frames both miss', async () => {
      ctx.cdp = vi.fn().mockImplementation((method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && (params == null || params.contextId === undefined)) {
          return Promise.resolve({ result: {} });
        }
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'top' }, childFrames: [] } });
        }
        return Promise.resolve({});
      });
      ctx.healFingerprintInContext = vi.fn().mockResolvedValue({
        cx: 10, cy: 10, score: 0.9, objectId: 'healed-obj', resolvedExpr: 'document.querySelector("#healed-name")',
      });
      (ctx.eval as any).mockResolvedValue({ verified: true, actual: 'John' });

      const result = await onFillForm(ctx, {
        fields: [{ selector: '#stale-name', value: 'John' }],
      }, {});

      expect(ctx.healFingerprintInContext).toHaveBeenCalledWith(null, '#stale-name');
      expect(result.content[0].text).toContain('✓');
      expect(result.content[0].text).toContain('#stale-name');
    });

    it('does not heal when ctx.healFingerprintInContext is not wired (experiment disabled)', async () => {
      ctx.cdp = vi.fn().mockImplementation((method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && (params == null || params.contextId === undefined)) {
          return Promise.resolve({ result: {} });
        }
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'top' }, childFrames: [] } });
        }
        return Promise.resolve({});
      });
      // ctx.healFingerprintInContext left unset.
      await expect(onFillForm(ctx, {
        fields: [{ selector: '#stale-name', value: 'John' }],
      }, {})).rejects.toThrow('Element not found: #stale-name');
    });
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

    expect(ctx.getElementCenter).toHaveBeenCalledWith('.source', { name: undefined, purpose: undefined });
    expect(ctx.getElementCenter).toHaveBeenCalledWith('.target', { name: undefined, purpose: undefined });
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

describe('secure_fill schema', () => {
  it('secure_fill schema carries the pre-deprecation notice', () => {
    const schema = getToolSchemas().find((t: any) => t.name === 'secure_fill');
    expect(schema?.description).toContain('being deprecated');
  });
});
