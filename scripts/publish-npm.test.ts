import { describe, it, expect } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { NPM_PACKAGES, npmPublishState, publishNpmPackages, prepareShimBinaries } from './publish-npm';
import type { GoRun } from './shim-build';

describe('NPM_PACKAGES', () => {
  it('publishes the daemon before the server, and no shim package', () => {
    expect(NPM_PACKAGES.map((p) => [p.dir, p.name])).toEqual([
      ['daemon', 'supersurf-daemon'],
      ['server', 'supersurf-mcp'],
    ]);
  });
});

describe('publishNpmPackages', () => {
  it('runs npm publish in each package directory, in order', () => {
    const calls: [string, string][] = [];
    publishNpmPackages('/r', (cmd, cwd) => calls.push([cmd, cwd]));
    expect(calls).toEqual([
      ['npm publish', resolve('/r', 'daemon')],
      ['npm publish', resolve('/r', 'server')],
    ]);
  });

  it('stops at the first failure so a dependent is never published before its dependency', () => {
    const calls: string[] = [];
    expect(() =>
      publishNpmPackages('/r', (_cmd, cwd) => {
        calls.push(cwd);
        if (cwd.endsWith('daemon')) throw new Error('403');
      }),
    ).toThrow('403');
    expect(calls).toEqual([resolve('/r', 'daemon')]);
  });
});

describe('npmPublishState', () => {
  const failWith = (stderr: string) => () => {
    throw Object.assign(new Error('x'), { stderr, stdout: '' });
  };
  it('is published when npm view finds the version', () => {
    const cmds: string[] = [];
    expect(npmPublishState('supersurf-daemon', '4.2.0', (c) => void cmds.push(c))).toBe('published');
    expect(cmds).toEqual(['npm view supersurf-daemon@4.2.0 version']);
  });
  it('is unpublished on a genuine 404, for a version or for a package never published', () => {
    expect(npmPublishState('p', '1.0.0', failWith('npm error code E404'))).toBe('unpublished');
    expect(npmPublishState('p', '1.0.0', failWith('No match found for version 1.0.0'))).toBe('unpublished');
  });
  it('throws on any other failure: it must not fail open', () => {
    expect(() => npmPublishState('p', '1.0.0', failWith('ENOTFOUND registry.npmjs.org'))).toThrow(/ENOTFOUND/);
  });
});

describe('prepareShimBinaries', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'prep-'));
  const writeOk: GoRun = (_go, args) => {
    const out = args[args.indexOf('-o') + 1];
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, Buffer.alloc(4096, 1));
    return 0;
  };

  it('always builds the four binaries, with the supersurf-mcp version, then checks them', () => {
    const dir = tmp();
    const seen: string[] = [];
    const out = prepareShimBinaries({ go: 'go', version: '7.7.7', serverDir: dir, run: (g, a, o) => (seen.push(a[a.indexOf('-ldflags') + 1]), writeOk(g, a, o)) });
    expect(out).toHaveLength(4);
    expect(new Set(seen)).toEqual(new Set(['-s -w -X main.version=7.7.7']));
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails when there is no Go toolchain: there is no legacy-only skip', () => {
    expect(() => prepareShimBinaries({ go: null, version: '1.0.0', serverDir: tmp() })).toThrow(/go toolchain/);
  });

  it('fails when a build leaves a binary the check rejects', () => {
    const dir = tmp();
    const empty: GoRun = (_g, a) => {
      const out = a[a.indexOf('-o') + 1];
      mkdirSync(join(out, '..'), { recursive: true });
      writeFileSync(out, '');
      return 0;
    };
    expect(() => prepareShimBinaries({ go: 'go', version: '1.0.0', serverDir: dir, run: empty })).toThrow(/not ready/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('publish.ts wiring', () => {
  const src = readFileSync(join(__dirname, 'publish.ts'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  const at = (s: string) => main.indexOf(s);

  it('builds the shim binaries after the tests and before --dry exits, any push or any npm publish', () => {
    const prep = at('prepareShimBinaries(');
    expect(prep).toBeGreaterThan(at('await runReleaseTests(root'));
    expect(prep).toBeLessThan(at('if (isDry)'));
    expect(prep).toBeLessThan(at('pushToGitHub('));
    expect(prep).toBeLessThan(at('publishNpm()'));
  });

  it('publishes through publishNpmPackages, not an inline package list', () => {
    expect(src).toContain('publishNpmPackages(root');
    expect(src).not.toContain("['daemon', 'server']");
  });

  it('pre-flight checks the registry for every package and no shim package or pin', () => {
    expect(src).not.toMatch(/shim\/package\.json|supersurf-(server|shim)/);
    expect(src).toContain('npmPublishState(');
    expect(src).toContain('NPM_PACKAGES');
  });
});
