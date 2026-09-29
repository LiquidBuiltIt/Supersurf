// scripts/install-latest.test.ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(__dirname, '..', 'docs', 'install.sh');
const run = (...args: string[]) =>
  spawnSync('sh', [script, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

describe('install.sh --latest', () => {
  it('parses as POSIX sh', () => {
    expect(spawnSync('sh', ['-n', script]).status).toBe(0);
  });

  it('documents --latest and SUPERSURF_SRC_DIR in --help', () => {
    const r = run('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--latest');
    expect(r.stdout).toContain('SUPERSURF_SRC_DIR');
  });

  it('refuses --latest combined with --version before any network work', () => {
    const r = run('--latest', '--version', '3.5.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--latest and --version cannot be combined');
  });
});
