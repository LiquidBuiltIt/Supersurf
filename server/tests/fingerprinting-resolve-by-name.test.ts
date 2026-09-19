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

  it('a bare snake_case string is never treated as a handle reference (hard switch — no shape guessing)', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const out = resolveSelectorOrHandle('https://x.com/home', 'tweet_button');
    expect(out.selector).toBe('tweet_button');
    expect(out.handle).toBeNull();
    expect(out.attempted).toBe(false);
  });

  it('translates a `@`-marked handle to its stored selector', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const out = resolveSelectorOrHandle('https://x.com/home', '@tweet_button');
    expect(out.selector).toBe('#post');
    expect(out.attempted).toBe(true);
  });

  it('leaves an unknown `@`-marked handle untouched (marker stripped) but reports the attempt', () => {
    const out = resolveSelectorOrHandle('https://x.com/home', '@tweet_button');
    expect(out.selector).toBe('tweet_button');
    expect(out.handle).toBeNull();
    expect(out.attempted).toBe(true);
  });

  it('is idempotent — translating a translated selector is a no-op', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const once = resolveSelectorOrHandle('https://x.com/home', '@tweet_button').selector;
    expect(once).toBe('#post');
    expect(resolveSelectorOrHandle('https://x.com/home', once).selector).toBe('#post');
  });

  it('strips the `@` marker even when the experiment is off, but does not resolve', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    mockEnabled.mockReturnValue(false);
    const out = resolveSelectorOrHandle('https://x.com/home', '@tweet_button');
    expect(out.selector).toBe('tweet_button');
    // The ephemeral tier (Task 4) is consulted even when the experiment is off,
    // so a lookup did run here — it just missed. `attempted` now reflects that.
    expect(out.attempted).toBe(true);
  });

  it('strips the `@` marker for the unknown domain bucket (nothing is ever stored there)', () => {
    const out = resolveSelectorOrHandle(undefined, '@tweet_button');
    expect(out.selector).toBe('tweet_button');
    // Same as above: the ephemeral tier still runs (and misses) for the 'unknown' bucket.
    expect(out.attempted).toBe(true);
  });
});

describe('resolveWithHealing with a handle name', () => {
  const url = 'https://x.com/home';

  it('queries the translated selector, not the handle name', async () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const { fn, seen } = fakeEval({ '#post': { x: 42, y: 43 } });
    const center = await resolveWithHealing(fn, '@tweet_button', () => url);
    expect(center).toEqual({ x: 42, y: 43, text: '', label: '' });
    expect(seen.some(e => e.includes('"#post"'))).toBe(true);
    expect(seen.some(e => e.includes('"tweet_button"'))).toBe(false);
  });

  it('emits handle.resolved with the match tier on a hit', async () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const events: AnyHandleEvent[] = [];
    const { fn } = fakeEval({ '#post': { x: 1, y: 2 } });
    await resolveWithHealing(fn, '@tweet_button', () => url, undefined, undefined, e => events.push(e));
    const ev = events.find(e => e.event === 'handle.resolved');
    expect(ev).toMatchObject({
      event: 'handle.resolved', name: '@tweet_button', match: 'canonical',
      candidateCount: 1, selector: '#post', domain: 'x.com', route: '/home',
    });
  });

  it('emits handle.resolved with match "miss" and falls through on an unknown handle', async () => {
    const events: AnyHandleEvent[] = [];
    const { fn } = fakeEval({});
    await expect(
      resolveWithHealing(fn, '@tweet_button', () => url, undefined, undefined, e => events.push(e)),
    ).rejects.toThrow(/tweet_button/);
    expect(events.find(e => e.event === 'handle.resolved')).toMatchObject({
      match: 'miss', candidateCount: 0, selector: '',
    });
  });

  it('appends a handle hint to the error when an unresolved `@`-marked handle fails as a selector', async () => {
    const { fn } = fakeEval({});
    await expect(resolveWithHealing(fn, '@tweet_button', () => url))
      .rejects.toThrow(/no recorded handle named `tweet_button`/);
  });

  it('a bare snake_case selector is never treated as a handle — it just misses as CSS', async () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const { fn } = fakeEval({});
    await expect(resolveWithHealing(fn, 'tweet_button', () => url))
      .rejects.not.toThrow(/no recorded handle named/);
  });

  it('appends the `@` hint when a bare snake_case selector misses and looks handle-shaped', async () => {
    const { fn } = fakeEval({});
    await expect(resolveWithHealing(fn, 'tweet_button', () => url))
      .rejects.toThrow(/If you meant the handle, target it with `@tweet_button`/);
  });

  it('does not append the `@` hint for a miss that is not handle-shaped', async () => {
    const { fn } = fakeEval({});
    await expect(resolveWithHealing(fn, '#post', () => url))
      .rejects.not.toThrow(/If you meant the handle/);
  });

  it('leaves plain-selector behaviour completely unchanged', async () => {
    const { fn, seen } = fakeEval({ '#post': { x: 7, y: 8 } });
    const center = await resolveWithHealing(fn, '#post', () => url);
    expect(center).toEqual({ x: 7, y: 8, text: '', label: '' });
    expect(seen.some(e => e.includes('"#post"'))).toBe(true);
  });

  it('falls through to the CSS path for a `@`-marked handle when the experiment is off, marker stripped', async () => {
    mockEnabled.mockReturnValue(false);
    const { fn, seen } = fakeEval({ tweet_button: { x: 3, y: 4 } });
    const center = await resolveWithHealing(fn, '@tweet_button', () => url);
    expect(center).toEqual({ x: 3, y: 4, text: '', label: '' });
    expect(seen.some(e => e.includes('"tweet_button"'))).toBe(true);
  });

  it('reports "no handle recorded" — not the `@` hint — when a marker-bearing selector misses with the experiment off', async () => {
    mockEnabled.mockReturnValue(false);
    const { fn } = fakeEval({});
    await expect(resolveWithHealing(fn, '@tweet_button', () => url))
      .rejects.toThrow(/No handle named `tweet_button` is recorded for this page/);
    await expect(resolveWithHealing(fn, '@tweet_button', () => url))
      .rejects.not.toThrow(/If you meant the handle/);
  });
});

import {
  bindEphemeral, bindSession, dropSession,
} from '../src/experimental/fingerprinting/ephemeral-handles';
import { EphemeralIdentityError, isEphemeralMiss } from '../src/experimental/fingerprinting/ephemeral-handles';

/**
 * The resolve-time identity guard, exercised through `resolveWithHealing` — the
 * only place a real caller meets it. `fakeEval` above returns coordinates only;
 * these cases need the element's text too, so they carry their own evaluator.
 */
describe('resolveWithHealing — ephemeral identity guard', () => {
  const url = 'https://news.ycombinator.com/';
  const SESSION = 's-guard';
  const FACTS = { matchSource: 'text' as const, matchValue: 'new', x: 262, y: 20 };

  /** Resolves every selector to one element, with the text the page would report. */
  const evalTo = (text: string, x = 146, y = 20) => {
    const calls: string[] = [];
    const fn = async (expr: string) => { calls.push(expr); return { x, y, text, label: '' }; };
    return { fn, calls };
  };

  beforeEach(() => {
    dropSession(SESSION);
    bindSession(SESSION);
    bindEphemeral(SESSION, 'new_a', 'a:has-text("new")', FACTS);
  });
  afterEach(() => dropSession(SESSION));

  it('resolves normally when the element still carries the minted text', async () => {
    const { fn } = evalTo('new', 262, 20);
    const center = await resolveWithHealing(fn, '@new_a', () => url);
    expect(center).toEqual({ x: 262, y: 20, text: 'new', label: '' });
  });

  it('refuses when the handle\'s selector now resolves to a different element', async () => {
    const { fn } = evalTo('Hacker News');
    await expect(resolveWithHealing(fn, '@new_a', () => url))
      .rejects.toBeInstanceOf(EphemeralIdentityError);
  });

  it('refuses on the experiment-OFF path too — ephemeral resolution is ungated', async () => {
    mockEnabled.mockReturnValue(false);
    const { fn } = evalTo('Hacker News');
    await expect(resolveWithHealing(fn, '@new_a', () => url))
      .rejects.toBeInstanceOf(EphemeralIdentityError);
  });

  it('does not append the "no recorded handle" hint to a refusal — the handle DID resolve', async () => {
    const { fn } = evalTo('Hacker News');
    await expect(resolveWithHealing(fn, '@new_a', () => url))
      .rejects.not.toThrow(/no recorded handle named/);
  });

  // The heal is the other escape hatch: it re-resolves by fingerprint and would
  // hand back coordinates for an element we have just proved is the wrong one.
  it('a fingerprint heal cannot rescue a refused handle', async () => {
    putRecord('news.ycombinator.com', '/', 'a:has-text("new")',
      rec({ selector: 'a:has-text("new")', text: 'new', cx: 999, cy: 999 }));
    const events: any[] = [];
    const { fn } = evalTo('Hacker News');
    await expect(
      resolveWithHealing(fn, '@new_a', () => url, e => events.push(e)),
    ).rejects.toBeInstanceOf(EphemeralIdentityError);
    expect(events.some(e => e.outcome === 'healed')).toBe(false);
  });

  // Capture writes the store. Writing a fingerprint for an element we just
  // rejected would teach the heal the wrong answer permanently.
  it('writes no fingerprint telemetry for a refused resolve', async () => {
    const events: any[] = [];
    const { fn } = evalTo('Hacker News');
    await expect(
      resolveWithHealing(fn, '@new_a', () => url, e => events.push(e)),
    ).rejects.toBeInstanceOf(EphemeralIdentityError);
    expect(events.some(e => e.outcome === 'resolved')).toBe(false);
  });

  it('leaves a plain CSS selector unguarded — there are no mint-time facts to check', async () => {
    const { fn } = evalTo('Hacker News');
    const center = await resolveWithHealing(fn, 'a:has-text("new")', () => url);
    expect(center).toMatchObject({ x: 146, y: 20 });
  });

  /**
   * A MISS (element gone) is not a mismatch, so it stays an ordinary Error — but
   * `getCenterInFrame` must be able to tell that the selector behind it came from
   * an ephemeral binding, because its child-frame fallback runs no identity check
   * and the candidates a binding is minted from are top-frame only.
   */
  describe('ephemeral provenance on a miss', () => {
    const missEval = async () => null;

    it('marks an ephemeral handle\'s miss, experiment ON', async () => {
      const err = await resolveWithHealing(missEval, '@new_a', () => url).catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(EphemeralIdentityError);
      expect(isEphemeralMiss(err)).toBe(true);
    });

    it('marks an ephemeral handle\'s miss on the experiment-OFF path too', async () => {
      mockEnabled.mockReturnValue(false);
      const err = await resolveWithHealing(missEval, '@new_a', () => url).catch(e => e);
      expect(isEphemeralMiss(err)).toBe(true);
    });

    it('never marks a plain CSS selector\'s miss', async () => {
      const err = await resolveWithHealing(missEval, 'a:has-text("new")', () => url).catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(isEphemeralMiss(err)).toBe(false);
    });

    it('never marks an unbound handle name\'s miss — nothing was translated', async () => {
      const err = await resolveWithHealing(missEval, '@never_minted', () => url).catch(e => e);
      expect(isEphemeralMiss(err)).toBe(false);
    });
  });
});
