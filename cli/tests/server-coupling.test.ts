/**
 * The K3 lock: `cli/` reaches into `server/src/` from exactly ONE file.
 *
 * cli/src/server-imports.ts is a deliberate, accepted coupling point — item 27
 * compiles `playbook ls|inspect|validate|migrate` into the binary and those
 * live under server/src. The alternative (hoisting them into shared/) would
 * force shared to declare acorn as a runtime dependency and break its
 * zero-runtime-dependency rule.
 *
 * A single coupling point that nothing enforces becomes five. This is the
 * enforcement. If it fails, do not add a second exemption — either route the
 * import through server-imports.ts, or reopen the shared/ hoist decision.
 *
 * SCOPE: this lock covers cli/src ONLY. cli/tests is deliberately exempt —
 * cli/tests/playbook-cli.test.ts imports test seams (setPlaybooksDirForTests,
 * setValidatorForTests) straight from server/src, and routing test-only
 * mutable-state hooks through the production barrel would be worse than the
 * coupling. The cost is real and accepted: test-side coupling to server/ can
 * accumulate with nothing noticing. What ships in the binary is cli/src, and
 * that is what this file locks.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', 'src');
const ALLOWED = 'server-imports.ts';

/** Every .ts file under cli/src, recursively, as paths relative to cli/src. */
function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else if (e.name.endsWith('.ts')) out.push(r);
  }
  return out;
}

/**
 * Any static import, re-export, require() or dynamic import() naming a specifier.
 *
 * The `import\s+` alternative catches the BARE side-effect form,
 * `import '../../server/src/tools/screenshot';`, which every other branch
 * misses because it has no `from`. That is not a hypothetical gap: this repo's
 * own boundary is `server/src/playbooks/run-cli.ts` — a live server-side
 * module that `cli/src/playbook-cli.ts` deliberately never imports, bare or
 * otherwise, because `run` shells out to the pinned `supersurf-mcp` package
 * instead of loading it in-process. Keeping that true is exactly what this
 * lock exists to enforce, so the bare form has to be caught even on a day no
 * file trips it.
 *
 * It cannot double-match `import x from 'y'`: the `import\s+` branch demands a
 * quote immediately after the whitespace, and there it finds an identifier.
 *
 * KNOWN BLIND SPOTS — string-literal specifiers ONLY. This regex produces ZERO
 * matches for any of the following, each of which couples cli/ to server/
 * exactly as much as a literal specifier would:
 *   - `await import(pkg)`                        — variable specifier: no
 *     quote immediately follows `import(`.
 *   - `` await import(`../../server/${sub}`) ``   — template literal: a
 *     backtick is not `['"]`.
 *   - `require(mod)`                              — variable specifier: no
 *     quote immediately follows `require(`.
 * Accepted, not an oversight: the syntax-blind backstop test below (scanning
 * for the raw substring `server/src`) catches all three, because a path built
 * this way still has to spell `server/src` out as a literal somewhere in the
 * file for `pkg`/`mod`/`sub` to ever resolve to it. A syntax-aware rewrite of
 * this regex would buy little over that second, dumber check.
 */
const SPECIFIER = /(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

describe('cli/ imports server source from exactly one file (BACKLOG #28, ruling K3)', () => {
  const files = walk(SRC);

  it('finds the cli source tree at all', () => {
    // Guards against the walk silently returning [] and the lock passing
    // vacuously. The tree holds 10 files; a threshold of 5 would still pass if
    // a regression halved the scanned set, so this sits just under the real
    // count rather than at half of it.
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files).toContain(ALLOWED);
  });

  it('no file other than server-imports.ts names a server/ specifier', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (rel === ALLOWED) continue;
      const txt = fs.readFileSync(path.join(SRC, rel), 'utf8');
      for (const m of txt.matchAll(SPECIFIER)) {
        if (/(^|\/)server\//.test(m[1])) offenders.push(`${rel} -> ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('server-imports.ts never reaches the runner, the tools tree or the experiment registry', () => {
    // Those three are what drag the ConnectionManager and, through
    // tools/screenshot.ts, the sharp native addon into the compiled binary.
    const txt = fs.readFileSync(path.join(SRC, ALLOWED), 'utf8');
    const specifiers = [...txt.matchAll(SPECIFIER)];
    // Same non-vacuity guard as test 1, one level down: an emptied
    // server-imports.ts would run this loop zero times and "pass".
    expect(specifiers.length).toBeGreaterThan(0);
    for (const m of specifiers) {
      expect(m[1]).not.toContain('playbooks/runner');
      expect(m[1]).not.toContain('/tools/');
      expect(m[1]).not.toContain('experimental');
    }
  });

  /**
   * Backstop for SPECIFIER's known blind spots (see the docblock above it):
   * a variable import()/require() specifier, or a template-literal specifier,
   * never matches that regex, because it only recognizes a string literal
   * immediately after `from`/`require(`/`import(`/`import `. Any of those
   * forms still has to spell the path out as a plain string SOMEWHERE in
   * the file for the variable to ever resolve to it — so a dumb whole-file
   * substring scan catches what the syntax-aware regex above misses, at the
   * cost of caring about syntax at all.
   *
   * `server/dist` is scanned alongside `server/src`. Importing the compiled
   * output is exactly as fatal to the standalone binary as importing the
   * source, and nothing else in this file would catch it.
   *
   * Comments are stripped first (preserving line numbers) so this doesn't
   * flag prose that merely NAMES a server/ path for documentation — e.g.
   * daemon-spawn.ts's own docblock, which compares itself to the separate
   * server/src/daemon-spawn.ts. That is not weaker coverage of the invariant:
   * reaching into server/ takes code, never a comment.
   */
  it('no file other than server-imports.ts contains a raw "server/src" or "server/dist" substring outside a comment (syntax-blind backstop)', () => {
    // Same non-vacuity guard as test 1: an emptied `files` list would make
    // this loop run zero times and pass for the wrong reason.
    expect(files.length).toBeGreaterThanOrEqual(8);
    const NEEDLES = ['server/src', 'server/dist'];

    const stripComments = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
        .replace(/\/\/.*$/gm, '');

    const offenders: string[] = [];
    for (const rel of files) {
      if (rel === ALLOWED) continue;
      const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
      const rawLines = raw.split('\n');
      const strippedLines = stripComments(raw).split('\n');
      strippedLines.forEach((line, idx) => {
        for (const needle of NEEDLES) {
          if (line.includes(needle)) {
            offenders.push(`${rel}:${idx + 1}: ${rawLines[idx].trim()}`);
            break;
          }
        }
      });
    }
    expect(
      offenders,
      'SPECIFIER only sees string-literal specifiers; this backstop catches variable ' +
        'and template-literal import()/require() forms it misses. Offender(s):\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
