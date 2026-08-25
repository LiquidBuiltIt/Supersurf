import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setBaseDirForTests, savePlaybook } from '../src/playbooks/store';
import { buildPlaybookDomainIndex, matchPlaybookNamesForUrl, formatPlaybookHintLine } from '../src/playbooks/hint';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-hint-'));
  setBaseDirForTests(dir);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function pb(name: string, url: string) {
  savePlaybook({ name, purpose: 'p', steps: [{ tool: 'browser_navigate', type: 'browser_navigate', params: {}, url, sourceId: 1 }], createdAt: 1, version: 1 });
}

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

describe('buildPlaybookDomainIndex / matchPlaybookNamesForUrl', () => {
  it('matches a playbook by its recorded step domain', () => {
    pb('gh_login', 'https://github.com/login');
    const index = buildPlaybookDomainIndex();
    expect(matchPlaybookNamesForUrl(index, 'https://github.com/settings')).toEqual(['gh_login']);
  });

  it('matches across the www. normalization on both sides', () => {
    pb('gh_login', 'https://www.github.com/login');
    const index = buildPlaybookDomainIndex();
    expect(matchPlaybookNamesForUrl(index, 'https://github.com/settings')).toEqual(['gh_login']);
  });

  it('does not suffix-walk — a subdomain is not a match', () => {
    pb('gh_login', 'https://github.com/login');
    const index = buildPlaybookDomainIndex();
    expect(matchPlaybookNamesForUrl(index, 'https://gist.github.com/x')).toBeNull();
  });

  it('returns null for no tab url', () => {
    const index = buildPlaybookDomainIndex();
    expect(matchPlaybookNamesForUrl(index, undefined)).toBeNull();
  });

  it('returns null when there is no match', () => {
    pb('gh_login', 'https://github.com/login');
    const index = buildPlaybookDomainIndex();
    expect(matchPlaybookNamesForUrl(index, 'https://example.com/')).toBeNull();
  });

  it('sorts multiple matching names alphabetically, once, at build time', () => {
    pb('gh_star', 'https://github.com/star');
    pb('gh_login', 'https://github.com/login');
    pb('gh_create_repo', 'https://github.com/new');
    const index = buildPlaybookDomainIndex();
    expect(matchPlaybookNamesForUrl(index, 'https://github.com/settings'))
      .toEqual(['gh_create_repo', 'gh_login', 'gh_star']);
  });
});
