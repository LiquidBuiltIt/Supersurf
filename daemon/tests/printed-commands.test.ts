import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { daemonCommand } from 'shared';

/**
 * BACKLOG #34. Two `console.log`/`throw` sites printed `supersurf-daemon
 * restart` and `supersurf-daemon status --verbose`. That bare name resolves
 * only after `npm i -g supersurf-daemon`, which no documented install path
 * performs — so both hints were `command not found` for every normal reader.
 *
 * The equivalent server-side string was corrected in BACKLOG #25, and these
 * survived because that plan's file list was scoped to `server/`. So this
 * sweep is deliberately NOT scoped to `daemon/`: a package-scoped grep is the
 * exact mistake being guarded against, and a lock with the same blind spot as
 * the bug would let the next copy through the same gap.
 */

const ROOT = resolve(__dirname, '..', '..');

const SKIP_DIRS = new Set(['dist']);
const SCAN_EXT = ['.ts', '.js', '.mjs', '.md', '.html', '.txt', '.sh'];

// Two files legitimately contain the banned shape: this one (it is quoted in
// the comment above and in the regex) and the changelog, an append-only record
// that must keep quoting the string the entry is about.
const EXEMPT = new Set(['daemon/tests/printed-commands.test.ts', 'CHANGELOG.md']);

// Enumerated from the git index, not from a directory walk. A walk sees
// whatever happens to sit on this disk — gitignored internal docs, another
// branch's checkout under a worktree dir — and fails on strings no reader can
// ever receive. The index is exactly the set that ships, which is the set this
// guard is about. It also stays correct without a skip list that has to learn
// each new untracked directory by failing a release first.
function sourceFiles(): string[] {
  return execSync('git ls-files -z', { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
    .filter((rel) => {
      const parts = rel.split('/');
      // `dist/` is tracked here, so the index alone does not exclude it.
      if (parts.some((p) => SKIP_DIRS.has(p) || p.endsWith('.old'))) return false;
      return SCAN_EXT.some((ext) => rel.endsWith(ext)) && !rel.endsWith('.old.ts');
    });
}

// A package name in a comparison (`pkg.name === 'supersurf-daemon'`) is fine.
// What is not fine is the package name followed by a subcommand — that shape
// is only ever an instruction to the reader, and it is only runnable via npx.
const BARE_INVOCATION = /(?<!npx )supersurf-daemon\s+(start|stop|restart|status|observe)/;

describe('no file in this repo prints a daemon command that assumes a global install', () => {
  const files = sourceFiles().filter((rel) => !EXEMPT.has(rel));

  it('scans the whole repo, not one package (guards against a silently narrow sweep)', () => {
    expect(files.length).toBeGreaterThan(100);
    for (const pkg of ['daemon/src', 'server/src', 'cli/src', 'extension/src', 'docs']) {
      expect(files.some((f) => f.startsWith(pkg))).toBe(true);
    }
  });

  it('finds no bare `supersurf-daemon <subcommand>` anywhere', () => {
    const offenders = files.flatMap((rel) =>
      readFileSync(join(ROOT, rel), 'utf8')
        .split('\n')
        .map((line, i) => ({ where: `${rel}:${i + 1}`, line: line.trim() }))
        .filter(({ line }) => BARE_INVOCATION.test(line)),
    );
    expect(offenders).toEqual([]);
  });
});

describe('daemonCommand', () => {
  it('builds a form that runs without a global install', () => {
    expect(daemonCommand('restart')).toBe('npx supersurf-daemon@latest restart');
  });

  it('does not itself produce the bare shape the sweep above bans', () => {
    expect(BARE_INVOCATION.test(daemonCommand('status --verbose'))).toBe(false);
  });
});
