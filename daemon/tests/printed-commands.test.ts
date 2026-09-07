import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';
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

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.worktrees', 'coverage']);
const SCAN_EXT = ['.ts', '.js', '.mjs', '.md', '.html', '.txt', '.sh'];

// Two files legitimately contain the banned shape: this one (it is quoted in
// the comment above and in the regex) and the changelog, an append-only record
// that must keep quoting the string the entry is about.
const EXEMPT = new Set(['daemon/tests/printed-commands.test.ts', 'CHANGELOG.md']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.endsWith('.old')) return [];
      return sourceFiles(full);
    }
    if (entry.endsWith('.old.ts')) return [];
    return SCAN_EXT.some((ext) => entry.endsWith(ext)) ? [full] : [];
  });
}

// A package name in a comparison (`pkg.name === 'supersurf-daemon'`) is fine.
// What is not fine is the package name followed by a subcommand — that shape
// is only ever an instruction to the reader, and it is only runnable via npx.
const BARE_INVOCATION = /(?<!npx )supersurf-daemon\s+(start|stop|restart|status|observe)/;

describe('no file in this repo prints a daemon command that assumes a global install', () => {
  const files = sourceFiles(ROOT)
    .map((f) => relative(ROOT, f))
    .filter((rel) => !EXEMPT.has(rel));

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
