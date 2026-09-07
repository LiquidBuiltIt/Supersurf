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
 * The equivalent server-side strings were corrected in BACKLOG #25, and these
 * survived because that plan's file list was scoped to `server/`. A grep is
 * what would have caught them, so a grep is what guards them now: correcting
 * the two literals fixes today, and this test is the part that fixes tomorrow.
 */

const SRC = resolve(__dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith('.ts') && !entry.endsWith('.old.ts') ? [full] : [];
  });
}

// A package name in a comparison (`pkg.name === 'supersurf-daemon'`) is fine.
// What is not fine is the package name followed by a subcommand — that shape
// is only ever an instruction to the reader, and it is only runnable via npx.
const BARE_INVOCATION = /(?<!npx )supersurf-daemon\s+(start|stop|restart|status|observe)/;

describe('daemon/src prints no command that assumes a global install', () => {
  const files = tsFiles(SRC);

  it('finds source files to scan (guards against a silently empty sweep)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [relative(SRC, f), f] as const))(
    '%s',
    (_rel, file) => {
      const offenders = readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => BARE_INVOCATION.test(line));
      expect(offenders).toEqual([]);
    },
  );
});

describe('daemonCommand', () => {
  it('builds a form that runs without a global install', () => {
    expect(daemonCommand('restart')).toBe('npx supersurf-daemon@latest restart');
  });

  it('does not itself produce the bare shape the sweep above bans', () => {
    expect(BARE_INVOCATION.test(daemonCommand('status --verbose'))).toBe(false);
  });
});
