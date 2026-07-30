import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('../src/experimental/index', async () => {
  const actual = await vi.importActual<typeof import('../src/experimental/index')>('../src/experimental/index');
  return { ...actual, experimentRegistry: { ...actual.experimentRegistry, isEnabled: vi.fn().mockReturnValue(false) } };
});

import { experimentRegistry } from '../src/experimental/index';
import { putRecord, setBaseDirForTests } from '../src/experimental/fingerprinting/store';
import type { FingerprintRecord } from '../src/experimental/fingerprinting/types';
import { BrowserBridge } from '../src/tools';

const mockEnabled = experimentRegistry.isEnabled as ReturnType<typeof vi.fn>;
const TMP = path.join(process.cwd(), '.tmp-fp-wiring');
setBaseDirForTests(TMP);

beforeEach(() => mockEnabled.mockImplementation((f: string) => f === 'fingerprinting'));
afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function rec(over: Partial<FingerprintRecord> & { selector: string }): FingerprintRecord {
  return {
    role: 'button', name: 'Post', text: 'Post', tag: 'button', type: null,
    attrs: {}, classList: [], htmlId: '', ordinal: 0, cx: 10, cy: 20,
    neighborText: '', landmark: '',
    capturedAt: 1, lastSeenAt: 1, hits: 1,
    ...over,
  };
}

/** A built ToolContext from a BrowserBridge with a stub transport and a fixed attached-tab URL. */
function ctxAt(url: string): any {
  const bridge: any = new BrowserBridge({}, { sendCmd: async () => ({}) } as any);
  bridge.connectionManager = { clientId: 'test', getAttachedTab: () => ({ url }) };
  return bridge.buildContext();
}

describe('ToolContext handle translation', () => {
  const url = 'https://x.com/home';

  it('resolveSelector translates a known handle', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    expect(ctxAt(url).resolveSelector('tweet_button')).toBe('#post');
  });

  it('resolveSelector passes a plain selector through', () => {
    const ctx = ctxAt(url);
    expect(ctx.resolveSelector('#post')).toBe('#post');
    expect(ctx.resolveSelector('button:has-text("Post")')).toBe('button:has-text("Post")');
  });

  it('resolveSelector returns an unknown handle unchanged', () => {
    expect(ctxAt(url).resolveSelector('tweet_button')).toBe('tweet_button');
  });

  it('getSelectorExpression embeds the translated selector, not the handle', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const expr = ctxAt(url).getSelectorExpression('tweet_button');
    expect(expr).toContain('"#post"');
    expect(expr).not.toContain('tweet_button');
  });

  it('getSelectorExpression still handles :has-text unchanged', () => {
    expect(ctxAt(url).getSelectorExpression('button:has-text("Post")')).toContain('textContent');
  });

  it('does not translate when the experiment is off', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    mockEnabled.mockReturnValue(false);
    expect(ctxAt(url).resolveSelector('tweet_button')).toBe('tweet_button');
  });
});

describe('raw-CDP selector sites translate handles', () => {
  /** Minimal ToolContext that records every CDP call and fakes handle translation. */
  function ctxSpy() {
    const calls: Array<{ method: string; params: any }> = [];
    const ctx: any = {
      resolveSelector: (s: string) => (s === 'tweet_button' ? '#post' : s),
      getSelectorExpression: (s: string) => `(()=>document.querySelector(${JSON.stringify(s)}))()`,
      cdp: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 7 };
        if (method === 'CSS.getMatchedStylesForNode') return { matchedCSSRules: [], inlineStyle: null };
        if (method === 'CSS.getComputedStyleForNode') return { computedStyle: [] };
        return {};
      },
      eval: async () => [],
      formatResult: (_n: string, r: any) => r,
      error: (m: string) => new Error(m),
    };
    return { ctx, calls };
  }

  it('force_pseudo_state queries the translated selector', async () => {
    const { executeAction } = await import('../src/tools/interaction/registry');
    await import('../src/tools/interaction/force-pseudo-state'); // registers as a side effect
    const { ctx, calls } = ctxSpy();
    await executeAction(ctx, { type: 'force_pseudo_state', selector: 'tweet_button', pseudoStates: ['hover'] });
    expect(calls.find(c => c.method === 'DOM.querySelector')?.params.selector).toBe('#post');
  });

  it('browser_get_element_styles queries the translated selector', async () => {
    const { onGetElementStyles } = await import('../src/tools/styles');
    const { ctx, calls } = ctxSpy();
    await onGetElementStyles(ctx, { selector: 'tweet_button' }, {});
    expect(calls.find(c => c.method === 'DOM.querySelector')?.params.selector).toBe('#post');
  });
});
