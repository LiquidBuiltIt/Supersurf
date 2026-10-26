import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, afterAll } from 'vitest';
import { hasLiveSource } from './shared-live';

const src = mkdtempSync(join(tmpdir(), 'shared-src-'));
afterAll(() => rmSync(src, { recursive: true, force: true }));
mkdirSync(join(src, 'config'));
mkdirSync(join(src, 'legacy.old'));
for (const f of ['index.ts', 'config/service.ts', 'retired.old.ts', 'legacy.old/a.ts']) writeFileSync(join(src, f), '');

describe('hasLiveSource', () => {
  it.each(['index.js', 'index.d.ts', 'index.js.map', 'index.d.ts.map', 'config/service.js', 'config/service.d.ts.map'])(
    'keeps %s, which has a live .ts source', (f) => expect(hasLiveSource(f, src)).toBe(true));

  it.each(['gone.js', 'gone.d.ts', 'gone.js.map', 'gone.d.ts.map', 'config/gone.js'])(
    'skips %s, whose .ts source was deleted', (f) => expect(hasLiveSource(f, src)).toBe(false));

  it.each(['retired.old.js', 'retired.old.d.ts', 'legacy.old/a.js'])(
    'skips %s, whose only source is a .old one', (f) => expect(hasLiveSource(f, src)).toBe(false));

  it('skips a file that is not a compiler output', () => expect(hasLiveSource('index.txt', src)).toBe(false));
});
