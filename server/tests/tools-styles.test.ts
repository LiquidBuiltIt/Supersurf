import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onGetElementStyles } from '../src/tools/styles';
import type { ToolContext } from '../src/tools/lib/types';

function createMockCtx(): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({}) } as any,
    connectionManager: null,
    cdp: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue([]),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn(),
    getSelectorExpression: vi.fn(),
    findAlternativeSelectors: vi.fn(),
    formatResult: vi.fn((_n, r) => ({ content: [{ type: 'text', text: JSON.stringify(r) }] })),
    error: vi.fn((msg) => ({ content: [{ type: 'text', text: msg }], isError: true })),
  };
}

describe('onGetElementStyles()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
    // DOM.getDocument
    (ctx.cdp as any).mockImplementation(async (method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 42 };
      if (method === 'CSS.getMatchedStylesForNode') {
        return {
          matchedCSSRules: [
            {
              rule: {
                origin: 'regular',
                selectorList: { selectors: [{ text: '.btn' }] },
                styleSheetId: 'sheet1',
                style: {
                  range: { startLine: 10 },
                  cssProperties: [
                    { name: 'color', value: 'red' },
                    { name: 'font-size', value: '16px' },
                  ],
                },
              },
            },
          ],
          inlineStyle: {
            cssProperties: [
              { name: 'margin', value: '10px' },
            ],
          },
        };
      }
      if (method === 'CSS.forcePseudoState') return {};
      return {};
    });
  });

  it('returns matched styles for a selector', async () => {
    const result = await onGetElementStyles(ctx, { selector: '.btn' }, {});

    expect(ctx.cdp).toHaveBeenCalledWith('DOM.getDocument', {});
    expect(ctx.cdp).toHaveBeenCalledWith('DOM.querySelector', { nodeId: 1, selector: '.btn' });
    expect(result.content[0].text).toContain('color');
    expect(result.content[0].text).toContain('red');
    expect(result.content[0].text).toContain('margin');
  });

  it('filters by specific property', async () => {
    const result = await onGetElementStyles(ctx, { selector: '.btn', property: 'color' }, { rawResult: true });

    expect(result.propertyCount).toBe(1);
    expect(result.properties['color']).toBeDefined();
    expect(result.properties['font-size']).toBeUndefined();
  });

  it('throws when element not found', async () => {
    (ctx.cdp as any).mockImplementation(async (method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 0 };
      return {};
    });

    await expect(onGetElementStyles(ctx, { selector: '.missing' }, {})).rejects.toThrow('Element not found');
  });

  it('forces pseudo-state when requested', async () => {
    await onGetElementStyles(ctx, { selector: '.btn', pseudoState: ['hover'] }, {});

    expect(ctx.cdp).toHaveBeenCalledWith('CSS.forcePseudoState', {
      nodeId: 42,
      forcedPseudoClasses: ['hover'],
    });
    // Clean up call (reset pseudo states)
    expect(ctx.cdp).toHaveBeenCalledWith('CSS.forcePseudoState', {
      nodeId: 42,
      forcedPseudoClasses: [],
    });
  });

  it('handles inline styles', async () => {
    const result = await onGetElementStyles(ctx, { selector: '.btn' }, { rawResult: true });
    expect(result.properties['margin']).toBeDefined();
    expect(result.properties['margin'][0].source).toBe('inline');
  });

  it('handles no styles found', async () => {
    (ctx.cdp as any).mockImplementation(async (method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 42 };
      if (method === 'CSS.getMatchedStylesForNode') {
        return { matchedCSSRules: [], inlineStyle: { cssProperties: [] } };
      }
      return {};
    });

    const result = await onGetElementStyles(ctx, { selector: '.empty' }, {});
    expect(result.content[0].text).toContain('No CSS styles found');
  });

  it('parses pseudoState from string', async () => {
    await onGetElementStyles(ctx, { selector: '.btn', pseudoState: 'hover' }, {});
    expect(ctx.cdp).toHaveBeenCalledWith('CSS.forcePseudoState', {
      nodeId: 42,
      forcedPseudoClasses: ['hover'],
    });
  });
});
