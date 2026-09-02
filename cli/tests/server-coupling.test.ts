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
 * misses because it has no `from`. That is not a hypothetical gap:
 * server/src/bin/supersurf-mcp.ts is literally `import '../cli';`, so the bare
 * form is the in-repo idiom for pulling the whole MCP server in for its side
 * effects — precisely what this lock exists to stop.
 *
 * It cannot double-match `import x from 'y'`: the `import\s+` branch demands a
 * quote immediately after the whitespace, and there it finds an identifier.
 */
const SPECIFIER = /(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

describe('cli/ imports server source from exactly one file (BACKLOG #28, ruling K3)', () => {
  const files = walk(SRC);

  it('finds the cli source tree at all', () => {
    // Guards against the walk silently returning [] and the lock passing vacuously.
    expect(files.length).toBeGreaterThan(5);
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
});
