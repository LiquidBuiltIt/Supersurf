import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const CLI_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(CLI_ROOT, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.resolve(CLI_ROOT, '..', 'package.json'), 'utf8'));

describe('cli package metadata', () => {
  it('is private and therefore unpublishable', () => {
    expect(pkg.private).toBe(true);
  });

  it('is a workspace member', () => {
    expect(rootPkg.workspaces).toContain('cli');
  });

  it('versions in lockstep with the root package', () => {
    expect(pkg.version).toBe(rootPkg.version);
  });

  it('declares no runtime dependencies — Bun bundles everything', () => {
    expect(pkg.dependencies).toBeUndefined();
  });

  it('declares all four compile targets', () => {
    const targets = fs.readFileSync(path.join(CLI_ROOT, 'build.ts'), 'utf8');
    for (const t of ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64']) {
      expect(targets).toContain(t);
    }
  });

  it('never emits a tracked dist/', () => {
    const tracked = execFileSync('git', ['ls-files', 'cli'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(tracked.some((f) => f.startsWith('cli/build/'))).toBe(false);
  });

  it('gitignores build output', () => {
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('cli/build/');
  });
});

describe('the binary never points a user at a name npm will never grant', () => {
  // Carried over from the old `server/tests/bin-entrypoints.test.ts` lock,
  // which scanned three shim files for a deprecation notice. Item 28 moved one
  // of those three into cli/src and the assertion did not come with it.
  //
  // The banned notice told users to run `npx supersurf ...`. The bare
  // `supersurf` npm name is a squatted 0.0.1 placeholder that is not this
  // project and never will be — npm refused the dispute on 2026-06-09. So a
  // "deprecated, use X instead" notice in the compiled binary can only send
  // someone to a stranger's package. There is no correct wording; the notice
  // itself is the defect.
  const SRC = path.resolve(CLI_ROOT, 'src');

  function walk(dir: string, rel = ''): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
      else if (e.name.endsWith('.ts')) out.push(r);
    }
    return out;
  }

  it('finds at least one source file to scan', () => {
    // Guards the scan below: it asserts an ABSENCE, so an empty file list
    // would pass it forever.
    expect(walk(SRC).length).toBeGreaterThan(0);
  });

  it('carries no deprecation notice anywhere in cli/src', () => {
    const offenders = walk(SRC).filter((rel) =>
      /Deprecated/i.test(fs.readFileSync(path.join(SRC, rel), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('version.bump and tree know about cli/', () => {
  const scripts = path.resolve(CLI_ROOT, '..', 'scripts');
  it('version.bump rewrites cli/package.json', () => {
    expect(fs.readFileSync(path.join(scripts, 'version.bump.ts'), 'utf8')).toContain("'cli/package.json'");
  });
  it('tree lists cli', () => {
    expect(fs.readFileSync(path.join(scripts, 'tree.ts'), 'utf8')).toMatch(/PACKAGES\s*=\s*\[[^\]]*'cli'/);
  });
});
