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

  // `npx supersurf-mcp` execs dist/cli.js directly through the bin symlink npm
  // creates, so the file has to be self-executable: lose the mode bit and npm
  // reports EACCES, lose the shebang and the shell runs it as a shell script.
  // Neither failure is visible to any assertion above — both leave the path,
  // the bin map and the file contents perfectly valid. `dist/` is tracked, so
  // the mode is a committed property of the repo and can regress in a diff.
  it('ships dist/cli.js executable', () => {
    const mode = fs.statSync(path.join(SERVER, 'dist', 'cli.js')).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('ships dist/cli.js with a shebang on the first line', () => {
    const first = fs.readFileSync(path.join(SERVER, 'dist', 'cli.js'), 'utf8').split('\n')[0];
    expect(first.startsWith('#!')).toBe(true);
  });

  it('main/types point at the CLI entry', () => {
    expect(pkg.main).toBe('dist/cli.js');
    expect(pkg.types).toBe('dist/cli.d.ts');
  });
});
