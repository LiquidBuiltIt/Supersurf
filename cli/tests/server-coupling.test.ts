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

/** Any static import, re-export, require() or dynamic import() naming a specifier. */
const SPECIFIER = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

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
    for (const m of txt.matchAll(SPECIFIER)) {
      expect(m[1]).not.toContain('playbooks/runner');
      expect(m[1]).not.toContain('/tools/');
      expect(m[1]).not.toContain('experimental');
    }
  });
});
