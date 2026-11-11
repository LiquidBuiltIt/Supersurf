import { describe, it, expect } from 'vitest';
import { selectorFromHit } from '../src/experimental/fingerprinting/selector-synthesis';
import type { ScoreHit } from '../src/experimental/fingerprinting/types';

function hit(over: Partial<ScoreHit> = {}): ScoreHit {
  return {
    cx: 10, cy: 20, score: 0.9, margin: 0.3,
    role: 'button', name: 'Post', tag: 'button', type: null,
    htmlId: '', attrs: {}, classList: [], ordinal: 0,
    ...over,
  };
}

describe('selectorFromHit', () => {
  it('prefers the html id', () => {
    expect(selectorFromHit(hit({ htmlId: 'tweet-btn' }))).toBe('button#tweet-btn');
  });

  it('rewrites a digit-leading id to attribute form (CSS forbids the ident)', () => {
    expect(selectorFromHit(hit({ htmlId: '883a76-abc' }))).toBe('button[id="883a76-abc"]');
  });

  it('falls back to the highest-trust stable attribute', () => {
    const s = selectorFromHit(hit({ attrs: { 'aria-label': 'Post', 'data-testid': 'tweetButton' } }));
    expect(s).toBe('button[data-testid="tweetButton"]');
  });

  it('honours the trust order across the whole allow-list', () => {
    expect(selectorFromHit(hit({ tag: 'input', attrs: { title: 'T', name: 'email' } })))
      .toBe('input[name="email"]');
  });

  it('escapes double quotes and backslashes in an attribute value', () => {
    expect(selectorFromHit(hit({ attrs: { 'aria-label': 'say "hi"' } })))
      .toBe('button[aria-label="say \\"hi\\""]');
  });

  it('returns null when only class names are available (hashed classes are not stable)', () => {
    expect(selectorFromHit(hit({ classList: ['r-1', 'r-2'] }))).toBeNull();
  });

  it('returns null when there is no identity at all', () => {
    expect(selectorFromHit(hit())).toBeNull();
  });

  it('ignores an empty-string attribute value', () => {
    expect(selectorFromHit(hit({ attrs: { 'data-testid': '' } }))).toBeNull();
  });
});
