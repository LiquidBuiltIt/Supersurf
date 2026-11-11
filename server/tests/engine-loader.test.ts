import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine } from '../src/engine-loader';

const SRC = path.resolve(__dirname, '../src');
const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []);

describe('loadEngine', () => {
  it('loads the engine bundled in supersurf-daemon (needs `npm run build`)', () => {
    const engine = loadEngine();
    expect(typeof engine.AgentSessionManager).toBe('function');
    expect(typeof engine.startScriptMode).toBe('function');
    expect(typeof engine.runPlaybookCli).toBe('function');
  });

  it('asks the resolver for the exact deep path inside supersurf-daemon', () => {
    let asked = '';
    expect(() => loadEngine((id) => { asked = id; throw new Error('nope'); })).toThrow();
    expect(asked).toBe('supersurf-daemon/dist/engine/index.js');
  });

  it('turns a resolution failure into an actionable message', () => {
    expect(() => loadEngine(() => { throw new Error('Cannot find module'); })).toThrow(
      /could not find its engine in supersurf-daemon.*Cannot find module.*npx supersurf-mcp@latest/s,
    );
  });
});

describe('server carries no engine copy (P1)', () => {
  it('has no value import of "engine" in src', () => {
    const bad = walk(SRC).filter((f) => /^\s*import\s+(?!type\b)[^;]*from\s+['"]engine['"]/m.test(fs.readFileSync(f, 'utf8')));
    expect(bad.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('declares no engine runtime dependency, keeps the exact daemon pin, and only types depend on engine', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    for (const dep of ['acorn', 'acorn-walk', 'image-size', 'sharp', 'engine']) {
      expect(pkg.dependencies[dep], dep).toBeUndefined();
    }
    expect(pkg.devDependencies.engine).toBe('*');
    expect(pkg.dependencies['supersurf-daemon']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
