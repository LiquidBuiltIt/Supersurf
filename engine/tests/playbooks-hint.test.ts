import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setPlaybooksDirForTests, playbookFile } from '../src/playbooks/paths';
import { refreshRegistry, resetRegistryForTests, setValidatorForTests } from '../src/playbooks/registry';
import {
  buildPlaybookDomainIndex, matchPlaybookNamesForUrl, formatPlaybookHintLine,
  formatInvalidPlaybookWarning, normalizeHost, normalizeDomain,
} from '../src/playbooks/hint';
import type { ValidationRecord } from '../src/security/validate';

// `normalizeHost` and `normalizeDomain` moved here verbatim from the deleted
// `playbooks/domains.ts`. These cases came with them unchanged — they are what
// pins "verbatim" to something checkable.
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

describe('formatPlaybookHintLine', () => {
  // formatPlaybookHintLine expects pre-sorted input (see doc comment) — every
  // case below passes names already in the order a real caller would provide
  // them (buildPlaybookDomainIndex sorts once at build time).

  it('renders the exact 1-5 format', () => {
    const line = formatPlaybookHintLine(['gh-create-repo', 'gh-login', 'gh-star']);
    expect(line).toBe('► 3 playbooks available: gh-create-repo, gh-login, gh-star | playbooks "list" for more details');
  });

  it('renders the exact 5-name boundary: all 5 shown, plain count, no "+ more"', () => {
    const line = formatPlaybookHintLine(['a', 'b', 'c', 'd', 'e']);
    expect(line).toBe('► 5 playbooks available: a, b, c, d, e | playbooks "list" for more details');
  });

  it('renders the exact 5+ format when more than 5 match', () => {
    const line = formatPlaybookHintLine(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(line).toBe('► 5+ playbooks available: a, b, c, d, e + more | playbooks "list" for more details');
  });

  it('caps the visible list at exactly 5 names', () => {
    const line = formatPlaybookHintLine(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    const namesClause = line.split(': ')[1].split(' | ')[0];
    expect(namesClause).toBe('a, b, c, d, e + more');
  });
});

describe('buildPlaybookDomainIndex — from meta.startingPoint', () => {
  let dir: string;
  const records: Record<string, Partial<ValidationRecord>> = {};

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-hint-'));
    setPlaybooksDirForTests(dir);
    resetRegistryForTests();
    for (const name of Object.keys(records)) delete records[name];
    setValidatorForTests(async (p: string) => {
      const name = path.basename(p).replace('.playbook.js', '');
      return {
        file: p, name, hash: name, valid: true, signature: `${name}()`, validatedAt: 1,
        meta: { description: name }, ...records[name],
      } as ValidationRecord;
    });
  });
  afterEach(() => {
    setValidatorForTests(null);
    resetRegistryForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function write(name: string, over: Partial<ValidationRecord>) {
    records[name] = over;
    fs.writeFileSync(playbookFile(name), `// ${name}`);
    await refreshRegistry();
  }

  it('indexes a script by its startingPoint host', async () => {
    await write('post_tweet', { meta: { description: 'x', startingPoint: 'x.com' } });
    const index = buildPlaybookDomainIndex();
    expect(matchPlaybookNamesForUrl(index, 'https://x.com/home')).toEqual(['post_tweet']);
  });

  it('normalizes a startingPoint given as a full URL or with www.', async () => {
    await write('a', { meta: { description: 'a', startingPoint: 'https://www.github.com/issues' } });
    const index = buildPlaybookDomainIndex();
    expect(matchPlaybookNamesForUrl(index, 'https://github.com/x/y')).toEqual(['a']);
  });

  it('matches across the www. normalization on both sides', async () => {
    await write('gh_login', { meta: { description: 'g', startingPoint: 'www.github.com' } });
    const index = buildPlaybookDomainIndex();
    expect(matchPlaybookNamesForUrl(index, 'https://github.com/settings')).toEqual(['gh_login']);
  });

  it('does not suffix-walk — a subdomain is not a match', async () => {
    await write('gh_login', { meta: { description: 'g', startingPoint: 'github.com' } });
    const index = buildPlaybookDomainIndex();
    expect(matchPlaybookNamesForUrl(index, 'https://gist.github.com/x')).toBeNull();
  });

  it('returns null for no tab url', async () => {
    await write('gh_login', { meta: { description: 'g', startingPoint: 'github.com' } });
    expect(matchPlaybookNamesForUrl(buildPlaybookDomainIndex(), undefined)).toBeNull();
  });

  it('returns null when there is no match', async () => {
    await write('gh_login', { meta: { description: 'g', startingPoint: 'github.com' } });
    expect(matchPlaybookNamesForUrl(buildPlaybookDomainIndex(), 'https://example.com/')).toBeNull();
  });

  it('skips scripts with no startingPoint', async () => {
    await write('a', { meta: { description: 'a' } });
    expect(buildPlaybookDomainIndex().size).toBe(0);
  });

  it('skips invalid scripts — a broken file is not a discovery suggestion', async () => {
    await write('a', { valid: false, error: 'blocked API: require', meta: undefined });
    expect(buildPlaybookDomainIndex().size).toBe(0);
  });

  it('groups and sorts multiple scripts on one domain', async () => {
    await write('z_task', { meta: { description: 'z', startingPoint: 'x.com' } });
    await write('a_task', { meta: { description: 'a', startingPoint: 'x.com' } });
    expect(matchPlaybookNamesForUrl(buildPlaybookDomainIndex(), 'https://x.com/')).toEqual(['a_task', 'z_task']);
  });
});

describe('formatInvalidPlaybookWarning', () => {
  it('returns null when nothing is invalid', () => {
    expect(formatInvalidPlaybookWarning([])).toBeNull();
  });

  it('names the broken scripts and their errors', () => {
    const line = formatInvalidPlaybookWarning([
      { name: 'a', error: 'blocked API: require' } as ValidationRecord,
      { name: 'b', error: 'no default export' } as ValidationRecord,
    ]);
    expect(line).toContain('a: blocked API: require');
    expect(line).toContain('b: no default export');
  });
});
