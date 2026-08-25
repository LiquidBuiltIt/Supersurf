import { describe, it, expect } from 'vitest';
import { normalizeHost, normalizeDomain, derivePlaybookDomains } from '../src/playbooks/domains';
import type { PlaybookStep } from '../src/playbooks/types';

function step(url: string | undefined, over: Partial<PlaybookStep> = {}): PlaybookStep {
  return { tool: 'browser_navigate', type: 'browser_navigate', params: {}, url, sourceId: 1, ...over };
}

describe('normalizeHost', () => {
  it('lowercases the host', () => {
    expect(normalizeHost('https://GitHub.com/foo')).toBe('github.com');
  });

  it('strips a leading www.', () => {
    expect(normalizeHost('https://www.github.com/foo')).toBe('github.com');
  });

  it('drops path, query and port from the host', () => {
    expect(normalizeHost('https://github.com:8080/a/b?c=1')).toBe('github.com');
  });

  it('returns null for a missing url', () => {
    expect(normalizeHost(undefined)).toBeNull();
    expect(normalizeHost(null)).toBeNull();
  });

  it('returns null for a malformed url', () => {
    expect(normalizeHost('not a url')).toBeNull();
  });

  it('returns null for a non-http(s) scheme', () => {
    expect(normalizeHost('chrome://extensions')).toBeNull();
    expect(normalizeHost('file:///tmp/x.html')).toBeNull();
    expect(normalizeHost('about:blank')).toBeNull();
  });
});

describe('normalizeDomain', () => {
  it('lowercases and strips www. from a bare domain string', () => {
    expect(normalizeDomain('WWW.GitHub.com')).toBe('github.com');
  });

  it('trims whitespace', () => {
    expect(normalizeDomain('  github.com  ')).toBe('github.com');
  });

  it('leaves a bare domain with no www. prefix unchanged', () => {
    expect(normalizeDomain('github.com')).toBe('github.com');
  });
});

describe('derivePlaybookDomains', () => {
  it('dedupes hostnames across steps', () => {
    const domains = derivePlaybookDomains([
      step('https://github.com/a'),
      step('https://github.com/b'),
      step('https://www.github.com/c'),
    ]);
    expect(domains).toEqual(['github.com']);
  });

  it('sorts domains alphabetically', () => {
    const domains = derivePlaybookDomains([step('https://zeta.com/'), step('https://alpha.com/')]);
    expect(domains).toEqual(['alpha.com', 'zeta.com']);
  });

  it('ignores steps with no url', () => {
    const domains = derivePlaybookDomains([step(undefined), step('https://github.com/')]);
    expect(domains).toEqual(['github.com']);
  });

  it('ignores steps with a non-http(s) url', () => {
    const domains = derivePlaybookDomains([step('chrome://extensions'), step('https://github.com/')]);
    expect(domains).toEqual(['github.com']);
  });

  it('ignores steps with a malformed url', () => {
    const domains = derivePlaybookDomains([step('not a url'), step('https://github.com/')]);
    expect(domains).toEqual(['github.com']);
  });

  it('returns an empty array for a playbook with no matchable urls', () => {
    expect(derivePlaybookDomains([step(undefined), step('chrome://extensions')])).toEqual([]);
  });
});
