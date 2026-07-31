// NOTE: `vi.spyOn(fs, 'statSync')` does not reliably intercept calls made by
// store.ts's own `import * as fs from 'node:fs'` in this Vitest/Node setup (see
// fingerprinting-store-cache.test.ts for the full explanation). `vi.mock`
// intercepts at module-resolution level instead, so it sees calls from every
// importer of 'node:fs', including store.ts.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { putRecord, setBaseDirForTests } from '../src/experimental/fingerprinting/store';
import type { FingerprintRecord } from '../src/experimental/fingerprinting/types';
import { experimentRegistry } from '../src/experimental/index';
import { buildHandleIndex, annotateSelector } from '../src/experimental/fingerprinting/handle-annotate';

const TMP = path.join(process.cwd(), '.tmp-fp-annotate');
setBaseDirForTests(TMP);

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
  setBaseDirForTests(TMP);
});

/** The experiment is off by default; every behavioural test opts in explicitly. */
function enableFingerprinting(): void {
  vi.spyOn(experimentRegistry, 'isEnabled').mockImplementation((n: string) => n === 'fingerprinting');
}

function rec(over: Partial<FingerprintRecord> & { selector: string }): FingerprintRecord {
  return {
    role: 'button', name: 'Post', text: 'Post', tag: 'button', type: null,
    attrs: {}, classList: [], htmlId: '', ordinal: 0, cx: 10, cy: 20,
    neighborText: '', landmark: '',
    capturedAt: 1, lastSeenAt: 1, hits: 1,
    ...over,
  };
}

describe('buildHandleIndex', () => {
  it('returns an empty index when the experiment is off', () => {
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    expect(buildHandleIndex('https://x.com/home').size).toBe(0);
  });

  it('indexes a record by its own stored selector', () => {
    enableFingerprinting();
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    expect(buildHandleIndex('https://x.com/home').get('#post')).toBe('tweet_button');
  });

  it('indexes the tag#id shape the readers synthesise', () => {
    enableFingerprinting();
    putRecord('x.com', '/home', 'button:has-text("Post")', rec({
      selector: 'button:has-text("Post")', handleName: 'tweet_button', tag: 'button', htmlId: 'post',
    }));
    const idx = buildHandleIndex('https://x.com/home');
    expect(idx.get('button#post')).toBe('tweet_button');
  });

  it('never indexes a bare #id shape — neither reader ever emits one', () => {
    enableFingerprinting();
    putRecord('x.com', '/home', 'button:has-text("Post")', rec({
      selector: 'button:has-text("Post")', handleName: 'tweet_button', tag: 'button', htmlId: 'post',
    }));
    expect(buildHandleIndex('https://x.com/home').get('#post')).toBeUndefined();
  });

  it("a record's own stored selector always wins its exact-match slot over another record's derived key", () => {
    enableFingerprinting();
    // Record A's derived key (`button#post`) is the exact string record B is stored
    // under. Insertion order matters here: A is written first so, under a naive
    // single-pass first-writer-wins build, A's derived key would occupy the
    // `button#post` slot before B's own stored selector is ever registered.
    putRecord('x.com', '/home', 'button:has-text("Post")', rec({
      selector: 'button:has-text("Post")', handleName: 'wrong_handle', tag: 'button', htmlId: 'post',
    }));
    putRecord('x.com', '/home', 'button#post', rec({
      selector: 'button#post', handleName: 'right_handle', tag: 'button', htmlId: 'post',
    }));
    const idx = buildHandleIndex('https://x.com/home');
    expect(idx.get('button#post')).toBe('right_handle');
  });

  it('indexes the tag[name="..."] shape for form fields without an id', () => {
    enableFingerprinting();
    putRecord('a.co', '/apply', 'input[name="fname"]', rec({
      selector: 'input[name="fname"]', handleName: 'first_name_input',
      tag: 'input', attrs: { name: 'fname' },
    }));
    expect(buildHandleIndex('https://a.co/apply').get('input[name="fname"]')).toBe('first_name_input');
  });

  it('never indexes a class-based shape', () => {
    enableFingerprinting();
    putRecord('a.co', '/apply', '.btn', rec({
      selector: '.btn', handleName: 'apply_button', tag: 'button', classList: ['btn', 'btn-primary'],
    }));
    const idx = buildHandleIndex('https://a.co/apply');
    expect(idx.get('button.btn.btn-primary')).toBeUndefined();
    expect(idx.get('.btn')).toBe('apply_button'); // its own stored selector still counts
  });

  it('skips records that never got a handle name', () => {
    enableFingerprinting();
    putRecord('x.com', '/home', '#anon', rec({ selector: '#anon' }));
    expect(buildHandleIndex('https://x.com/home').size).toBe(0);
  });

  it('does not cross route boundaries', () => {
    enableFingerprinting();
    putRecord('x.com', '/home', '#post', rec({ selector: '#post', handleName: 'tweet_button' }));
    expect(buildHandleIndex('https://x.com/compose').size).toBe(0);
  });

  it('returns an empty index for an unusable URL', () => {
    enableFingerprinting();
    expect(buildHandleIndex(undefined).size).toBe(0);
    expect(buildHandleIndex('not a url').size).toBe(0);
  });

  it('reads the domain store once regardless of record count', () => {
    enableFingerprinting();
    for (let i = 0; i < 20; i++) {
      putRecord('x.com', '/home', `#el-${i}`, rec({ selector: `#el-${i}`, handleName: `thing_${i}` }));
    }
    (fs.statSync as unknown as ReturnType<typeof vi.fn>).mockClear();
    buildHandleIndex('https://x.com/home');
    expect(fs.statSync).toHaveBeenCalledTimes(1);
  });
});

describe('annotateSelector', () => {
  it('substitutes the handle in front of the selector on a hit', () => {
    const idx = new Map([['#post', 'tweet_button']]);
    expect(annotateSelector(idx, '#post')).toBe('tweet_button [#post]');
  });

  it('returns the selector byte-identical on a miss', () => {
    const idx = new Map([['#post', 'tweet_button']]);
    expect(annotateSelector(idx, 'div.card')).toBe('div.card');
  });

  it('returns the selector byte-identical against an empty index', () => {
    expect(annotateSelector(new Map(), '#post')).toBe('#post');
  });
});
