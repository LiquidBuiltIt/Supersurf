import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './harness';

const p = (...s: string[]) => path.join(REPO, ...s);
const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

describe('published layout (needs `npm run build`)', () => {
  it('the daemon package carries the engine', () => {
    expect(fs.existsSync(p('daemon/dist/engine/index.js'))).toBe(true);
    expect(fs.existsSync(p('daemon/dist/engine/security/sandbox/child.js'))).toBe(true);
  });

  it('the bundle has no package.json, so sandbox read roots resolve to the daemon package', () => {
    expect(walk(p('daemon/dist/engine')).filter((f) => path.basename(f) === 'package.json')).toEqual([]);
  });

  it('every shared require in the bundled engine is rewritten to a relative path', () => {
    const bad = walk(p('daemon/dist/engine')).filter(
      (f) => f.endsWith('.js') && /require\((["'])shared(\/[^"']*)?\1\)/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(bad).toEqual([]);
  });

  it('the server package has no engine code (no dist/engine directory, no moved file)', () => {
    expect(fs.existsSync(p('server/dist/engine'))).toBe(false);
    for (const f of ['agent-session-manager.js', 'backend.js', 'tools.js', 'stdio.js']) {
      expect(fs.existsSync(p('server/dist', f)), f).toBe(false);
    }
  });
});
