import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name.endsWith('.old') ? [] : walk(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.old.ts') ? [p] : [];
  });
}

const files = walk(SRC).map((f) => ({ f: path.relative(SRC, f), text: fs.readFileSync(f, 'utf8') }));

describe('engine boundary', () => {
  it('imports no daemon lifecycle, socket link, host wiring or legacy bridge module', () => {
    const bad = files.filter(({ text }) => /from\s+['"][^'"]*(daemon-spawn|socket-link|engine-host|backend-config|\/bridge)['"]/.test(text));
    expect(bad.map((b) => b.f)).toEqual([]);
  });

  it('imports no DaemonClient value from shared (a host hands the engine its link)', () => {
    const bad = files.filter(({ text }) => /import\s*\{[^}]*\bDaemonClient\b[^}]*\}\s*from\s*['"]shared['"]/.test(text));
    expect(bad.map((b) => b.f)).toEqual([]);
  });

  it('requires no package.json (the version comes from the host)', () => {
    const bad = files.filter(({ text }) => /require\(['"][^'"]*package\.json['"]\)/.test(text));
    expect(bad.map((b) => b.f)).toEqual([]);
  });
});
