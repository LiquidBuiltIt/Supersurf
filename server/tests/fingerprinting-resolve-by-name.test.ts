import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock the experiment registry so we control isEnabled (same pattern as
// fingerprinting-integration.test.ts — importActual keeps the rest of the module real).
vi.mock('../src/experimental/index', async () => {
  const actual = await vi.importActual<typeof import('../src/experimental/index')>('../src/experimental/index');
  return { ...actual, experimentRegistry: { ...actual.experimentRegistry, isEnabled: vi.fn().mockReturnValue(false) } };
});

import { experimentRegistry } from '../src/experimental/index';
import { putRecord, setBaseDirForTests } from '../src/experimental/fingerprinting/store';
import type { FingerprintRecord } from '../src/experimental/fingerprinting/types';
import { resolveSelectorOrHandle } from '../src/experimental/fingerprinting/handle-resolve';
import { resolveWithHealing } from '../src/experimental/fingerprinting/index';
import type { AnyHandleEvent } from '../src/experimental/fingerprinting/index';

const mockEnabled = experimentRegistry.isEnabled as ReturnType<typeof vi.fn>;
const TMP = path.join(process.cwd(), '.tmp-fp-resolve-by-name');
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

/** Fake page evaluator: resolves centers for the selectors in `found`, misses otherwise. */
function fakeEval(found: Record<string, { x: number; y: number }>) {
  const seen: string[] = [];
  const fn = async (expr: string) => {
    seen.push(expr);
    for (const [sel, center] of Object.entries(found)) {
      if (expr.includes(JSON.stringify(sel))) return center;
    }
    return null;
  };
  return { fn, seen };
}

describe('resolveSelectorOrHandle', () => {
  it('passes a real CSS selector straight through without touching the store', () => {
    const out = resolveSelectorOrHandle('https://x.com/home', '#post');
    expect(out.selector).toBe('#post');
    expect(out.handle).toBeNull();
    expect(out.attempted).toBe(false);
  });

  it('translates a known handle to its stored selector', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const out = resolveSelectorOrHandle('https://x.com/home', 'tweet_button');
    expect(out.selector).toBe('#post');
    expect(out.handle?.match).toBe('canonical');
    expect(out.attempted).toBe(true);
  });

  it('leaves an unknown handle untouched but reports the attempt', () => {
    const out = resolveSelectorOrHandle('https://x.com/home', 'tweet_button');
    expect(out.selector).toBe('tweet_button');
    expect(out.handle).toBeNull();
    expect(out.attempted).toBe(true);
  });

  it('is idempotent — translating a translated selector is a no-op', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const once = resolveSelectorOrHandle('https://x.com/home', 'tweet_button').selector;
    expect(resolveSelectorOrHandle('https://x.com/home', once).selector).toBe('#post');
  });

  it('does nothing when the experiment is off', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    mockEnabled.mockReturnValue(false);
    const out = resolveSelectorOrHandle('https://x.com/home', 'tweet_button');
    expect(out.selector).toBe('tweet_button');
    expect(out.attempted).toBe(false);
  });

  it('does nothing for the unknown domain bucket (nothing is ever stored there)', () => {
    const out = resolveSelectorOrHandle(undefined, 'tweet_button');
    expect(out.selector).toBe('tweet_button');
    expect(out.attempted).toBe(false);
  });
});

describe('resolveWithHealing with a handle name', () => {
  const url = 'https://x.com/home';

  it('queries the translated selector, not the handle name', async () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const { fn, seen } = fakeEval({ '#post': { x: 42, y: 43 } });
    const center = await resolveWithHealing(fn, 'tweet_button', () => url);
    expect(center).toEqual({ x: 42, y: 43 });
    expect(seen.some(e => e.includes('"#post"'))).toBe(true);
    expect(seen.some(e => e.includes('"tweet_button"'))).toBe(false);
  });

  it('emits handle.resolved with the match tier on a hit', async () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const events: AnyHandleEvent[] = [];
    const { fn } = fakeEval({ '#post': { x: 1, y: 2 } });
    await resolveWithHealing(fn, 'tweet_button', () => url, undefined, undefined, e => events.push(e));
    const ev = events.find(e => e.event === 'handle.resolved');
    expect(ev).toMatchObject({
      event: 'handle.resolved', name: 'tweet_button', match: 'canonical',
      candidateCount: 1, selector: '#post', domain: 'x.com', route: '/home',
    });
  });

  it('emits handle.resolved with match "miss" and falls through on an unknown handle', async () => {
    const events: AnyHandleEvent[] = [];
    const { fn } = fakeEval({});
    await expect(
      resolveWithHealing(fn, 'tweet_button', () => url, undefined, undefined, e => events.push(e)),
    ).rejects.toThrow(/tweet_button/);
    expect(events.find(e => e.event === 'handle.resolved')).toMatchObject({
      match: 'miss', candidateCount: 0, selector: '',
    });
  });

  it('appends a handle hint to the error when an unresolved handle fails as a selector', async () => {
    const { fn } = fakeEval({});
    await expect(resolveWithHealing(fn, 'tweet_button', () => url))
      .rejects.toThrow(/no recorded handle named `tweet_button`/);
  });

  it('leaves plain-selector behaviour completely unchanged', async () => {
    const { fn, seen } = fakeEval({ '#post': { x: 7, y: 8 } });
    const center = await resolveWithHealing(fn, '#post', () => url);
    expect(center).toEqual({ x: 7, y: 8 });
    expect(seen.some(e => e.includes('"#post"'))).toBe(true);
  });

  it('falls through to the CSS path for a handle when the experiment is off', async () => {
    mockEnabled.mockReturnValue(false);
    const { fn, seen } = fakeEval({ tweet_button: { x: 3, y: 4 } });
    const center = await resolveWithHealing(fn, 'tweet_button', () => url);
    expect(center).toEqual({ x: 3, y: 4 });
    expect(seen.some(e => e.includes('"tweet_button"'))).toBe(true);
  });
});
