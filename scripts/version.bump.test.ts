import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { cutUnreleased } from './changelog-cut';
import { VERSION_TARGETS, EXTENSION_CHANGELOG_JSON, assertCleanMain, stagedPaths, commitRelease, bumpLockfile } from './bump-helpers';

describe('cutUnreleased', () => {
  it('moves Unreleased bullets into a new version section, leaving Unreleased empty', () => {
    const content = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '- feat: something new',
      '- fix: something fixed',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '- initial release',
      '',
    ].join('\n');

    const result = cutUnreleased(content, '1.1.0', '2026-08-05');

    expect('warning' in result).toBe(false);
    if ('warning' in result) return; // narrow for TS
    expect(result.moved).toBe(2);

    const lines = result.content.split('\n');
    // fresh empty Unreleased: header immediately followed by one blank line
    // then the new version header — no bullets left behind.
    expect(lines).toEqual([
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '## 1.1.0 — 2026-08-05', // em dash, not a hyphen
      '',
      '- feat: something new',
      '- fix: something fixed',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '- initial release',
      '',
    ]);
  });

  it('inserts the blurb as an italic paragraph under the heading, above the bullets', () => {
    const content = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '- feat: something new',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '- initial release',
      '',
    ].join('\n');

    const result = cutUnreleased(content, '1.1.0', '2026-08-05', 'Playbooks can now run on their own.');

    expect('warning' in result).toBe(false);
    if ('warning' in result) return;

    const lines = result.content.split('\n');
    expect(lines).toEqual([
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '## 1.1.0 — 2026-08-05',
      '',
      '*Playbooks can now run on their own.*',
      '',
      '- feat: something new',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '- initial release',
      '',
    ]);
    // the blurb is a paragraph, not an item — moved counts bullets only
    expect(result.moved).toBe(1);
  });

  it('omits the blurb paragraph entirely when blurb is absent, empty, or whitespace-only', () => {
    const content = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '- feat: something new',
      '',
    ].join('\n');

    for (const blurb of [undefined, '', '   ']) {
      const result = cutUnreleased(content, '1.1.0', '2026-08-05', blurb);
      expect('warning' in result).toBe(false);
      if ('warning' in result) continue;
      expect(result.content).not.toContain('*');
    }
  });

  it('warns and leaves content untouched when Unreleased has no bullets', () => {
    const content = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '## 3.3.0 — 2026-08-05',
      '',
      '- some prior release note',
      '',
    ].join('\n');

    const result = cutUnreleased(content, '3.4.0', '2026-08-05');

    expect('warning' in result).toBe(true);
    if (!('warning' in result)) return;
    expect(result.warning).toMatch(/empty/i);
  });

  it('warns when the Unreleased header is missing entirely', () => {
    const content = [
      '# Changelog',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '- initial release',
      '',
    ].join('\n');

    const result = cutUnreleased(content, '1.1.0', '2026-08-05');

    expect('warning' in result).toBe(true);
    if (!('warning' in result)) return;
    expect(result.warning).toMatch(/no.*unreleased/i);
  });

  it('throws when a section for the new version already exists', () => {
    const content = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '- feat: something new',
      '',
      '## 1.1.0 — 2026-07-01',
      '',
      '- already shipped',
      '',
    ].join('\n');

    expect(() => cutUnreleased(content, '1.1.0', '2026-08-05')).toThrow(/already has a "## 1\.1\.0" section/);
  });
});

// version.bump writes this pin. A range here let a fresh clone, and the
// published supersurf-mcp, install an older daemon from npm (^3.0.0 at 4.0.0).
describe('server daemon pin', () => {
  it('pins supersurf-daemon to exactly the daemon workspace version', () => {
    const read = (rel: string) => JSON.parse(readFileSync(join(__dirname, '..', rel), 'utf8'));
    expect(read('server/package.json').dependencies['supersurf-daemon']).toBe(read('daemon/package.json').version);
  });
});

const g = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Throwaway git repo on `main` with one commit, removed after each test.
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bump-'));
  fixtures.push(dir);
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 't');
  g(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('assertCleanMain', () => {
  it('passes on a clean main', () => {
    expect(() => assertCleanMain(fixture())).not.toThrow();
  });

  it('throws naming the branch when not on main, unless forced', () => {
    const dir = fixture();
    execFileSync('git', ['switch', '-q', '-c', 'feat/x'], { cwd: dir });
    expect(() => assertCleanMain(dir)).toThrow(/feat\/x/);
    expect(() => assertCleanMain(dir, { force: true })).not.toThrow();
  });

  it('throws on a dirty tree, even when forced, and lists the file', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'stray.txt'), 'x');
    expect(() => assertCleanMain(dir)).toThrow(/stray\.txt/);
    expect(() => assertCleanMain(dir, { force: true })).toThrow(/stray\.txt/);
  });
});

describe('bumpLockfile', () => {
  const ws = ['server', 'extension', 'daemon', 'shared', 'cli'];
  const lockAt = (v: string) => ({
    name: 'supersurf', version: v, lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'supersurf', version: v, workspaces: ws },
      ...Object.fromEntries(ws.map((w) => [w, { version: v }])),
      server: { version: v, dependencies: { 'supersurf-daemon': v, ws: '^8.0.0' } },
      'node_modules/supersurf-daemon': { resolved: 'daemon', link: true },
      'node_modules/ws': { version: '8.18.0' },
    },
  });
  const text = (o: object) => JSON.stringify(o, null, 2) + '\n';

  it('moves the root, every workspace and the daemon pin to the new version, and nothing else', () => {
    expect(bumpLockfile(text(lockAt('4.1.0')), '4.2.0')).toBe(text(lockAt('4.2.0')));
  });

  it('round-trips byte for byte when the version does not change', () => {
    expect(bumpLockfile(text(lockAt('4.1.0')), '4.1.0')).toBe(text(lockAt('4.1.0')));
  });

  it('throws naming a workspace the lock does not know', () => {
    const lock = lockAt('4.1.0');
    delete (lock.packages as Record<string, unknown>).cli;
    expect(() => bumpLockfile(text(lock), '4.2.0')).toThrow(/cli/);
  });
});

describe('stagedPaths', () => {
  const blog = 'blog/src/content/blog/9.9.0.mdx';

  it('lists version targets, both changelogs and the blog post', () => {
    expect(stagedPaths(blog)).toEqual([
      'package.json',
      'server/package.json',
      'extension/package.json',
      'extension/manifest.json',
      'daemon/package.json',
      'shared/package.json',
      'cli/package.json',
      'package-lock.json',
      'CHANGELOG.md',
      'extension/dist/pages/changelog.json',
      blog,
    ]);
  });

  it('omits the blog post when there is none, and never stages "."', () => {
    expect(stagedPaths(null)).toHaveLength(VERSION_TARGETS.length + 3);
    expect(stagedPaths(null)).toContain('package-lock.json');
    expect(stagedPaths(null)).toContain(EXTENSION_CHANGELOG_JSON);
    expect(stagedPaths(null)).not.toContain('.');
    expect(stagedPaths(blog)).not.toContain('.');
  });
});

describe('commitRelease', () => {
  it('commits a message full of shell metacharacters verbatim and only the listed paths', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'b.txt'), 'changed\n');
    const msg = 'v9.9.0 — code `username` and "quoted" and $(id) and `whoami`';
    commitRelease(dir, ['a.txt'], msg, 'pipe');
    expect(g(dir, 'log', '-1', '--format=%B').replace(/\n+$/, '')).toBe(msg);
    expect(g(dir, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('a.txt');
    expect(g(dir, 'status', '--porcelain').trim()).toBe('M b.txt');
  });
});

describe('version.bump.ts source', () => {
  it('never stages everything and never builds the commit through a shell string', () => {
    const src = readFileSync(join(__dirname, 'version.bump.ts'), 'utf8');
    expect(src).not.toMatch(/git add \./);
    expect(src).not.toMatch(/git commit -m "/);
    expect(src).toContain('bumpLockfile(');
  });
});
