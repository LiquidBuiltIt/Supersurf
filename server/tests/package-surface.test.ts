import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SERVER = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));

describe('supersurf-mcp package surface', () => {
  it('exposes exactly one bin, so `npx supersurf-mcp` resolves', () => {
    expect(Object.keys(pkg.bin)).toEqual(['supersurf-mcp']);
  });

  it('points that bin at the server CLI, not at a shim', () => {
    expect(pkg.bin['supersurf-mcp']).toBe('dist/cli.js');
    expect(fs.existsSync(path.join(SERVER, 'dist', 'cli.js'))).toBe(true);
  });

  it('no longer claims the `supersurf` name — that is the compiled binary', () => {
    expect(pkg.bin.supersurf).toBeUndefined();
  });

  it('no longer ships a duplicate supersurf-daemon bin', () => {
    expect(pkg.bin['supersurf-daemon']).toBeUndefined();
  });

  it('ships no CLI source or build output', () => {
    expect(fs.existsSync(path.join(SERVER, 'src', 'bin'))).toBe(false);
    expect(fs.existsSync(path.join(SERVER, 'dist', 'bin'))).toBe(false);
  });

  it('main/types point at the CLI entry', () => {
    expect(pkg.main).toBe('dist/cli.js');
    expect(pkg.types).toBe('dist/cli.d.ts');
  });
});
