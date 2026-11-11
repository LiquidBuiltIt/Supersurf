import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../src');
const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []);

describe('E1: the daemon carries the engine but does not load it', () => {
  it('no daemon source imports or requires the engine', () => {
    const bad = walk(SRC).filter((f) => /(from|require\()\s*['"][^'"]*\bengine\b[^'"]*['"]/.test(fs.readFileSync(f, 'utf8')));
    expect(bad.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
