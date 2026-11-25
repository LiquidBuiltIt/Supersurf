import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const root = join(__dirname, '..');
const text = (rel: string) => readFileSync(join(root, rel), 'utf8');
const read = (rel: string) => JSON.parse(text(rel));

describe('shim layout: the Go shim lives in server/ and ships inside supersurf-mcp', () => {
  it('has no root shim/ dir; the Go module is server/shim', () => {
    expect(existsSync(join(root, 'shim'))).toBe(false);
    expect(existsSync(join(root, 'server/shim/go.mod'))).toBe(true);
  });

  it('no package named supersurf-server: not a workspace, dependency or lockfile entry', () => {
    expect(read('package.json').workspaces).not.toContain('shim');
    for (const p of ['package.json', 'shared', 'engine', 'daemon', 'server', 'cli', 'extension'].map((d) => (d.endsWith('.json') ? d : `${d}/package.json`))) {
      const pkg = read(p);
      expect(pkg.name).not.toBe('supersurf-server');
      for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) expect(pkg[k]?.['supersurf-server']).toBeUndefined();
    }
    expect(existsSync(join(root, 'server/shim/package.json'))).toBe(false);
    expect(text('package-lock.json')).not.toMatch(/supersurf-server"/);
  });

  it('server/package.json ships bin (not shim) and checks the binaries before publish', () => {
    const server = read('server/package.json');
    expect(server.files).toContain('bin');
    expect(server.files).not.toContain('shim');
    expect(server.scripts.prepublishOnly).toContain('shim-build.ts --check');
  });

  it('build output is ignored under server/bin', () => {
    expect(spawnSync('git', ['check-ignore', '-q', 'server/bin/linux-amd64/supersurf-server'], { cwd: root }).status).toBe(0);
  });

  it('build.shim and build.shim.all write under server/bin; npm run build stays free of Go', () => {
    const s = read('package.json').scripts;
    expect(s['build.shim']).toContain('cd server/shim');
    expect(s['build.shim']).toContain('../bin/');
    expect(s['build.shim']).not.toContain('daemon/bin');
    expect(s['build.shim.all']).toBe('npx tsx scripts/shim-build.ts');
    expect(text('scripts/shim-build.ts')).toContain("'server'");
    expect(s.build).not.toMatch(/shim/);
  });
});
