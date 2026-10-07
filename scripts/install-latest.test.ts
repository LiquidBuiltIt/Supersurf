// scripts/install-latest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

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

// The only folder --latest may delete is a clone it made itself, inside
// ~/.supersurf/dev. Everything else in ~/.supersurf (profiles, playbooks,
// config, logs) and any other checkout must survive every re-run.
describe('install.sh --latest clone safety', () => {
  let t: string;
  let home: string;
  let src: string;
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

  // npm is stubbed; the run then stops at the tsx lookup, after the clone
  // logic under test has finished. Exit codes are not asserted for that reason.
  const latest = (extraEnv: Record<string, string> = {}) =>
    spawnSync('sh', [script, '--latest', '--yes', '--dir', join(t, 'bin')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        HOME: home,
        PATH: `${join(t, 'stub')}:${process.env.PATH}`,
        SUPERSURF_SRC_URL: src,
        ...extraEnv,
      },
    });

  beforeEach(() => {
    t = fs.mkdtempSync(join(os.tmpdir(), 'install-latest-'));
    home = join(t, 'home');
    src = join(t, 'src');
    fs.mkdirSync(home);
    fs.mkdirSync(join(t, 'stub'));
    fs.writeFileSync(join(t, 'stub', 'npm'), '#!/bin/sh\necho "$@" >> "$(dirname "$0")/npm-args"\n', { mode: 0o755 });
    fs.mkdirSync(src);
    git(src, 'init', '-q', '-b', 'main');
    fs.writeFileSync(join(src, 'README.md'), 'x\n');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    fs.rmSync(t, { recursive: true, force: true });
  });

  // A clone has no lockfile, and npm's peer resolver crashes on a fresh tree
  // (`Cannot read properties of null (reading 'edgesOut')`).
  it('installs dependencies with --legacy-peer-deps', () => {
    latest();
    expect(fs.readFileSync(join(t, 'stub', 'npm-args'), 'utf8')).toContain('install --legacy-peer-deps');
  });

  it('clones a dirty default clone again', () => {
    const clone = join(home, '.supersurf', 'dev', 'src');
    latest();
    fs.writeFileSync(join(clone, 'DIRTY'), '');
    const r = latest();
    expect(r.stdout).toContain('Cloning it again');
    expect(fs.existsSync(join(clone, 'DIRTY'))).toBe(false);
    expect(fs.existsSync(join(clone, 'README.md'))).toBe(true);
  });

  it('keeps the clone when the remote cannot be reached', () => {
    const clone = join(home, '.supersurf', 'dev', 'src');
    latest();
    fs.writeFileSync(join(clone, 'DIRTY'), '');
    fs.renameSync(src, src + '-offline');
    const r = latest();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Could not fetch');
    expect(fs.existsSync(join(clone, 'DIRTY'))).toBe(true);
  });

  it('never deletes a checkout the installer did not clone', () => {
    const repo = join(home, 'work', 'supersurf');
    fs.mkdirSync(join(home, 'work'));
    git(join(home, 'work'), 'clone', '-q', src, repo);
    fs.writeFileSync(join(repo, 'MY_WORK'), '');
    const r = latest({ SUPERSURF_SRC_DIR: repo });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('was not cloned by this installer');
    expect(fs.existsSync(join(repo, 'MY_WORK'))).toBe(true);
  });

  it('never deletes a clone inside ~/.supersurf but outside ~/.supersurf/dev', () => {
    const clone = join(home, '.supersurf', 'profiles');
    latest({ SUPERSURF_SRC_DIR: clone });
    fs.writeFileSync(join(clone, 'PROFILE_DATA'), '');
    const r = latest({ SUPERSURF_SRC_DIR: clone });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Refusing to delete');
    expect(fs.existsSync(join(clone, 'PROFILE_DATA'))).toBe(true);
  });

  it('never deletes ~/.supersurf itself', () => {
    const clone = join(home, '.supersurf');
    latest({ SUPERSURF_SRC_DIR: clone });
    fs.writeFileSync(join(clone, 'config.json'), '{}');
    const r = latest({ SUPERSURF_SRC_DIR: clone });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Refusing to delete');
    expect(fs.existsSync(join(clone, 'config.json'))).toBe(true);
  });
});
