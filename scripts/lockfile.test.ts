// scripts/lockfile.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { VERSION_TARGETS } from './bump-helpers';

const root = join(__dirname, '..');
const read = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

describe('package-lock.json', () => {
  it('is tracked at the repo root', () => {
    expect(execFileSync('git', ['ls-files', 'package-lock.json'], { cwd: root, encoding: 'utf8' }).trim())
      .toBe('package-lock.json');
  });

  it('nests no copy of a workspace package (BACKLOG #79)', () => {
    const lock = read('package-lock.json');
    expect(Object.keys(lock.packages).filter((k) => /\/node_modules\/supersurf-/.test(k))).toEqual([]);
    expect(lock.packages['node_modules/supersurf-daemon']).toMatchObject({ link: true, resolved: 'daemon' });
  });

  it('carries the workspace versions and the daemon pin', () => {
    const lock = read('package-lock.json');
    const v = read('package.json').version;
    expect(lock.version).toBe(v);
    expect(lock.packages[''].version).toBe(v);
    for (const rel of VERSION_TARGETS.filter((p) => p.endsWith('/package.json'))) {
      expect(lock.packages[rel.slice(0, -'/package.json'.length)].version, rel).toBe(read(rel).version);
    }
    expect(lock.packages.server.dependencies['supersurf-daemon'])
      .toBe(read('server/package.json').dependencies['supersurf-daemon']);
  });
});
