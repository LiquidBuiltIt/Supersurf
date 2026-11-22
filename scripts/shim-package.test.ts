import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const root = join(__dirname, '..');
const read = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

describe('supersurf-shim package', () => {
  const shim = read('shim/package.json');

  it('is a root workspace at the same version as the other packages', () => {
    expect(read('package.json').workspaces).toContain('shim');
    expect(shim.name).toBe('supersurf-shim');
    expect(shim.version).toBe(read('package.json').version);
  });

  it('ships only the binaries, README and LICENSE, with no bin field', () => {
    expect(shim.files).toEqual(['bin', 'README.md', 'LICENSE']);
    expect(shim.bin).toBeUndefined();
  });

  it('copies LICENSE and checks the binaries before publish', () => {
    expect(shim.scripts.prepublishOnly).toContain('cp ../LICENSE .');
    expect(shim.scripts.prepublishOnly).toContain('shim-build.ts --check');
  });

  it('daemon depends on it at exactly the shim version; the server adds nothing', () => {
    expect(read('daemon/package.json').dependencies['supersurf-shim']).toBe(shim.version);
    expect(read('server/package.json').dependencies?.['supersurf-shim']).toBeUndefined();
  });

  it('build.shim.all exists and the build output is ignored', () => {
    expect(read('package.json').scripts['build.shim.all']).toBe('npx tsx scripts/shim-build.ts');
    expect(spawnSync('git', ['check-ignore', '-q', 'shim/bin/linux-amd64/supersurf-shim'], { cwd: root }).status).toBe(0);
  });

  it('npm run build stays free of Go', () => {
    expect(read('package.json').scripts.build).not.toMatch(/shim/);
  });
});
