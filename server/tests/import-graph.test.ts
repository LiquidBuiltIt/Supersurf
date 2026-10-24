import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '../src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name.endsWith('.old') ? [] : sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.old.ts') ? [p] : [];
  });
}

const rel = (abs: string) => path.relative(SRC, abs).split(path.sep).join('/');

/** Static value-import graph: file -> files it imports at runtime. Keys and values are paths relative to SRC. */
function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const edges: string[] = [];
    for (const st of sf.statements) {
      let spec: string | undefined;
      if (ts.isImportDeclaration(st)) {
        const c = st.importClause;
        const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : [];
        const allTypeOnly = !!c && (c.isTypeOnly || (!c.name && named.length > 0 && named.every((el) => el.isTypeOnly)));
        if (!allTypeOnly && ts.isStringLiteral(st.moduleSpecifier)) spec = st.moduleSpecifier.text;
      } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && !st.isTypeOnly) {
        if (ts.isStringLiteral(st.moduleSpecifier)) spec = st.moduleSpecifier.text;
      }
      if (!spec || !spec.startsWith('.')) continue;
      const base = path.resolve(path.dirname(file), spec);
      const target = [base + '.ts', path.join(base, 'index.ts')].find((p) => fs.existsSync(p));
      if (target) edges.push(rel(target));
    }
    graph.set(rel(file), edges);
  }
  return graph;
}

/** Files reachable from `from` over one or more edges (includes `from` only if it is on a cycle). */
function reach(graph: Map<string, string[]>, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(graph.get(from) ?? [])];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...(graph.get(f) ?? []));
  }
  return seen;
}

describe('server import graph (static value imports only)', () => {
  it('has no static value-import cycles', () => {
    const g = buildGraph();
    const onCycle = [...g.keys()].filter((f) => reach(g, f).has(f)).sort();
    expect(onCycle).toEqual([]);
  });

  it('backend.ts never statically reaches tools.ts or tools/screenshot.ts (sharp)', () => {
    const g = buildGraph();
    for (const k of ['backend.ts', 'tools.ts', 'tools/screenshot.ts']) expect(g.has(k)).toBe(true);
    const r = reach(g, 'backend.ts');
    expect(r.has('tools.ts')).toBe(false);
    expect(r.has('tools/screenshot.ts')).toBe(false);
  });
});
