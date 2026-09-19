import { describe, it, expect, beforeEach } from 'vitest';
import {
  mintHandleName, bindEphemeral, resolveEphemeral, bindSession, dropSession,
} from '../src/experimental/fingerprinting/ephemeral-handles';
import { looksLikeHandle } from '../src/experimental/fingerprinting/handle-resolve';

/** Neutral facts for the cases that predate them and assert nothing about identity. */
const NO_FACTS = { matchSource: null, matchValue: '', x: 0, y: 0 };

describe('mintHandleName()', () => {
  it('derives a two-word name from visible text', () => {
    expect(mintHandleName({ text: 'Got it', tag: 'span' }, new Set())).toBe('got_it');
  });

  it('pads a single-word name with the tag so it satisfies the handle grammar', () => {
    const name = mintHandleName({ text: 'Submit', tag: 'button' }, new Set())!;
    expect(name).toBe('submit_button');
    expect(looksLikeHandle(name)).toBe(true);
  });

  it('falls back to the accessible-name label when there is no direct text', () => {
    expect(mintHandleName({ label: 'Close dialog', tag: 'button' }, new Set())).toBe('close_dialog');
  });

  it('emits NO handle when there is no confident text source', () => {
    expect(mintHandleName({ tag: 'div' }, new Set())).toBeNull();
    expect(mintHandleName({ text: '   ', label: '', tag: 'div' }, new Set())).toBeNull();
    expect(mintHandleName({ text: '!!!', tag: 'div' }, new Set())).toBeNull();
  });

  it('dedupes within one candidate list', () => {
    const taken = new Set<string>();
    expect(mintHandleName({ text: 'Got it', tag: 'span' }, taken)).toBe('got_it');
    expect(mintHandleName({ text: 'Got it', tag: 'span' }, taken)).toBe('got_it_2');
    expect(mintHandleName({ text: 'Got it', tag: 'span' }, taken)).toBe('got_it_3');
  });

  it('every minted name satisfies the handle grammar', () => {
    for (const text of ['Got it', 'Submit', 'Sign in with Google', 'OK', '  Save   changes  ']) {
      const name = mintHandleName({ text, tag: 'button' }, new Set());
      expect(name === null || looksLikeHandle(name)).toBe(true);
    }
  });

  it('caps a long phrase at four tokens', () => {
    expect(mintHandleName({ text: 'Accept all cookies and continue browsing', tag: 'button' }, new Set()))
      .toBe('accept_all_cookies_and');
  });
});

describe('session lifecycle', () => {
  beforeEach(() => {
    dropSession('s1');
    dropSession('s2');
  });

  it('resolves a bound name', () => {
    bindSession('s1');
    bindEphemeral('s1', 'got_it', 'span.a.b', NO_FACTS);
    expect(resolveEphemeral('got_it')).toBe('span.a.b');
  });

  it('returns null for an unbound name', () => {
    bindSession('s1');
    expect(resolveEphemeral('never_minted')).toBeNull();
  });

  it('drops everything for a session on disconnect', () => {
    bindSession('s1');
    bindEphemeral('s1', 'got_it', 'span.a.b', NO_FACTS);
    dropSession('s1');
    expect(resolveEphemeral('got_it')).toBeNull();
  });

  it('re-minting the same name overwrites the selector', () => {
    bindSession('s1');
    bindEphemeral('s1', 'got_it', 'span.old', NO_FACTS);
    bindEphemeral('s1', 'got_it', 'span.new', NO_FACTS);
    expect(resolveEphemeral('got_it')).toBe('span.new');
  });

  it('evicts oldest entries past the per-session cap', () => {
    bindSession('s1');
    for (let i = 0; i < 205; i++) bindEphemeral('s1', `name_${i}`, `sel${i}`, NO_FACTS);
    expect(resolveEphemeral('name_0')).toBeNull();
    expect(resolveEphemeral('name_204')).toBe('sel204');
  });
});

import { vi } from 'vitest';
import { resolveSelectorOrHandle } from '../src/experimental/fingerprinting/handle-resolve';
import { experimentRegistry } from '../src/experimental/index';

vi.mock('../src/experimental/fingerprinting/store', () => ({
  loadDomain: vi.fn(() => ({
    routes: {
      '/doc': {
        'button.persisted': {
          selector: 'button.persisted', handleName: 'got_it',
          hits: 5, lastSeenAt: 2, tag: 'button', attrs: {},
        },
      },
    },
  })),
}));

describe('resolveSelectorOrHandle() — ephemeral tier ordering', () => {
  beforeEach(() => {
    dropSession('eph');
    bindSession('eph');
  });

  it('prefers the persistent store over an ephemeral name that collides', () => {
    vi.spyOn(experimentRegistry, 'isEnabled').mockReturnValue(true);
    bindEphemeral('eph', 'got_it', 'span.ephemeral', NO_FACTS);
    const out = resolveSelectorOrHandle('https://docs.google.com/doc', '@got_it');
    expect(out.selector).toBe('button.persisted');
    expect(out.handle).not.toBeNull();
    expect(out.ephemeral).toBeFalsy();
  });

  it('falls through to ephemeral when the persistent store misses', () => {
    vi.spyOn(experimentRegistry, 'isEnabled').mockReturnValue(true);
    bindEphemeral('eph', 'close_dialog', 'span.ephemeral', NO_FACTS);
    const out = resolveSelectorOrHandle('https://docs.google.com/doc', '@close_dialog');
    expect(out.selector).toBe('span.ephemeral');
    expect(out.ephemeral).toBe(true);
    expect(out.attempted).toBe(true);
  });

  it('resolves an ephemeral handle with the fingerprinting experiment OFF', () => {
    vi.spyOn(experimentRegistry, 'isEnabled').mockReturnValue(false);
    bindEphemeral('eph', 'got_it', 'span.ephemeral', NO_FACTS);
    const out = resolveSelectorOrHandle('https://docs.google.com/doc', '@got_it');
    expect(out.selector).toBe('span.ephemeral');
    expect(out.ephemeral).toBe(true);
  });

  it('still strips the marker and returns the bare name on a total miss', () => {
    vi.spyOn(experimentRegistry, 'isEnabled').mockReturnValue(false);
    const out = resolveSelectorOrHandle('https://docs.google.com/doc', '@never_minted');
    expect(out.selector).toBe('never_minted');
    expect(out.ephemeral).toBeFalsy();
  });

  it('leaves a plain CSS selector untouched', () => {
    const out = resolveSelectorOrHandle('https://docs.google.com/doc', 'button.foo');
    expect(out.selector).toBe('button.foo');
    expect(out.attempted).toBe(false);
  });
});

describe('cross-session name collisions', () => {
  beforeEach(() => {
    dropSession('old');
    dropSession('new');
  });

  it('resolves to the most recently minted binding, not the oldest session', () => {
    bindSession('old');
    bindSession('new');
    bindEphemeral('old', 'got_it', 'span.old', NO_FACTS);
    bindEphemeral('new', 'got_it', 'span.new', NO_FACTS);
    expect(resolveEphemeral('got_it')).toBe('span.new');
  });

  it('a later re-mint by the older session wins it back', () => {
    bindSession('old');
    bindSession('new');
    bindEphemeral('old', 'got_it', 'span.old', NO_FACTS);
    bindEphemeral('new', 'got_it', 'span.new', NO_FACTS);
    bindEphemeral('old', 'got_it', 'span.old2', NO_FACTS);
    expect(resolveEphemeral('got_it')).toBe('span.old2');
  });

  it('falls back to the surviving session when the newest one disconnects', () => {
    bindSession('old');
    bindSession('new');
    bindEphemeral('old', 'got_it', 'span.old', NO_FACTS);
    bindEphemeral('new', 'got_it', 'span.new', NO_FACTS);
    dropSession('new');
    expect(resolveEphemeral('got_it')).toBe('span.old');
  });
});

import { resolveEphemeralBinding } from '../src/experimental/fingerprinting/ephemeral-handles';

describe('binding identity facts', () => {
  const FACTS = { matchSource: 'text' as const, matchValue: 'new', x: 262, y: 20 };

  beforeEach(() => { dropSession('s-facts'); bindSession('s-facts'); });

  it('stores the facts alongside the selector', () => {
    bindEphemeral('s-facts', 'new_a', 'a:has-text("new")', FACTS);
    const b = resolveEphemeralBinding('new_a');
    expect(b).not.toBeNull();
    expect(b!.selector).toBe('a:has-text("new")');
    expect(b!.facts).toEqual(FACTS);
  });

  it('resolveEphemeral still returns just the selector string', () => {
    bindEphemeral('s-facts', 'new_a', 'a:has-text("new")', FACTS);
    expect(resolveEphemeral('new_a')).toBe('a:has-text("new")');
  });

  it('a re-mint replaces the facts, not just the selector', () => {
    bindEphemeral('s-facts', 'new_a', 'a:nth-of-type(2)', FACTS);
    bindEphemeral('s-facts', 'new_a', 'a:has-text("new")', { ...FACTS, x: 999 });
    expect(resolveEphemeralBinding('new_a')!.facts.x).toBe(999);
  });

  it('returns null for an unknown name', () => {
    expect(resolveEphemeralBinding('never_minted')).toBeNull();
  });
});
