import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleEngine } from './engine-bundle-lib';

let root: string;
const w = (rel: string, body = 'x') => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-bundle-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('bundleEngine', () => {
  it('copies engine/dist into daemon/dist/engine, files with a live source only', () => {
    w('engine/src/a.ts'); w('engine/src/sub/b.ts');
    w('engine/dist/a.js'); w('engine/dist/a.d.ts'); w('engine/dist/sub/b.js');
    w('engine/dist/stale.js'); // no engine/src/stale.ts
    w('daemon/dist/main.js');
    const n = bundleEngine(root);
    expect(n).toBe(3);
    expect(fs.existsSync(path.join(root, 'daemon/dist/engine/a.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'daemon/dist/engine/sub/b.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'daemon/dist/engine/stale.js'))).toBe(false);
  });

  it('never ships a package.json (the sandbox read root must resolve to the daemon package)', () => {
    w('engine/src/a.ts'); w('engine/dist/a.js'); w('engine/dist/package.json', '{}');
    bundleEngine(root);
    expect(fs.existsSync(path.join(root, 'daemon/dist/engine/package.json'))).toBe(false);
  });

  it('removes a previous bundle first', () => {
    w('engine/src/a.ts'); w('engine/dist/a.js');
    w('daemon/dist/engine/old.js');
    bundleEngine(root);
    expect(fs.existsSync(path.join(root, 'daemon/dist/engine/old.js'))).toBe(false);
  });

  it('throws when engine/dist is missing', () => {
    fs.mkdirSync(path.join(root, 'daemon/dist'), { recursive: true });
    expect(() => bundleEngine(root)).toThrow(/engine\/dist/);
  });
});
