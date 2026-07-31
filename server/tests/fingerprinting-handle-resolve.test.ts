import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { putRecord, setBaseDirForTests } from '../src/experimental/fingerprinting/store';
import type { FingerprintRecord } from '../src/experimental/fingerprinting/types';
import { looksLikeHandle, resolveHandleName } from '../src/experimental/fingerprinting/handle-resolve';

const TMP = path.join(process.cwd(), '.tmp-fp-handle-resolve');
setBaseDirForTests(TMP);
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

function rec(over: Partial<FingerprintRecord> & { selector: string }): FingerprintRecord {
  return {
    role: 'button', name: 'Post', text: 'Post', tag: 'button', type: null,
    attrs: {}, classList: [], htmlId: '', ordinal: 0, cx: 10, cy: 20,
    neighborText: '', landmark: '',
    capturedAt: 1, lastSeenAt: 1, hits: 1,
    ...over,
  };
}

describe('looksLikeHandle', () => {
  it('accepts multi-word snake_case', () => {
    expect(looksLikeHandle('tweet_button')).toBe(true);
    expect(looksLikeHandle('first_name_input')).toBe(true);
    expect(looksLikeHandle('field_2_value')).toBe(true);
  });

  it('rejects single words so HTML tag selectors are never mistaken for handles', () => {
    expect(looksLikeHandle('button')).toBe(false);
    expect(looksLikeHandle('input')).toBe(false);
    expect(looksLikeHandle('a')).toBe(false);
  });

  it('rejects anything with CSS syntax', () => {
    expect(looksLikeHandle('#tweet_button')).toBe(false);
    expect(looksLikeHandle('.tweet_button')).toBe(false);
    expect(looksLikeHandle('div .tweet_button')).toBe(false);
    expect(looksLikeHandle('[data-x=tweet_button]')).toBe(false);
    expect(looksLikeHandle('button:has-text("Post")')).toBe(false);
    expect(looksLikeHandle('div > my_thing')).toBe(false);
    expect(looksLikeHandle('a_b,c_d')).toBe(false);
  });

  it('rejects non-canonical casing and stray underscores', () => {
    expect(looksLikeHandle('Tweet_Button')).toBe(false);
    expect(looksLikeHandle('_tweet_button')).toBe(false);
    expect(looksLikeHandle('tweet_button_')).toBe(false);
    expect(looksLikeHandle('tweet__button')).toBe(false);
  });

  it('rejects empty, non-strings and over-long input', () => {
    expect(looksLikeHandle('')).toBe(false);
    expect(looksLikeHandle(undefined as unknown as string)).toBe(false);
    expect(looksLikeHandle('a_' + 'b'.repeat(80))).toBe(false);
  });
});

describe('resolveHandleName', () => {
  it('returns null when the domain store does not exist', () => {
    expect(resolveHandleName('nope.com', '/', 'tweet_button')).toBeNull();
  });

  it('resolves a canonical handle to its selector', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    const got = resolveHandleName('x.com', '/home', 'tweet_button');
    expect(got?.selector).toBe('#post');
    expect(got?.candidateCount).toBe(1);
  });

  it('counts every record carrying the canonical name', () => {
    putRecord('x.com', '/home', '#one', rec({ selector: '#one', handleName: 'tweet_button', hits: 1 }));
    putRecord('x.com', '/home', '#two', rec({ selector: '#two', handleName: 'tweet_button', hits: 9 }));
    const got = resolveHandleName('x.com', '/home', 'tweet_button');
    expect(got?.selector).toBe('#two'); // hits desc
    expect(got?.candidateCount).toBe(2);
  });

  it('breaks a same-tier tie on hits, then on recency', () => {
    putRecord('a.co', '/jobs', '#one', rec({ selector: '#one', handleName: 'apply_button', hits: 2, lastSeenAt: 100 }));
    putRecord('a.co', '/jobs', '#two', rec({ selector: '#two', handleName: 'apply_button', hits: 9, lastSeenAt: 50 }));
    expect(resolveHandleName('a.co', '/jobs', 'apply_button')?.selector).toBe('#two');

    putRecord('b.co', '/jobs', '#old', rec({ selector: '#old', handleName: 'apply_button', hits: 4, lastSeenAt: 100 }));
    putRecord('b.co', '/jobs', '#new', rec({ selector: '#new', handleName: 'apply_button', hits: 4, lastSeenAt: 900 }));
    expect(resolveHandleName('b.co', '/jobs', 'apply_button')?.selector).toBe('#new');
  });

  it('does not cross route boundaries (route templating is out of scope)', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    expect(resolveHandleName('x.com', '/compose', 'tweet_button')).toBeNull();
  });

  it('normalizes the incoming name before matching', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    expect(resolveHandleName('x.com', '/home', 'Tweet Button')?.selector).toBe('#post');
  });

  it('ignores records that never got a handle name', () => {
    putRecord('x.com', '/home', '#anon', rec({ selector: '#anon' }));
    expect(resolveHandleName('x.com', '/home', 'tweet_button')).toBeNull();
  });
});
