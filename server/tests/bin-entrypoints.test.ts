/**
 * The `supersurf-mcp` entrypoint lock.
 *
 * WHAT CHANGED AND WHY (BACKLOG #28). This file used to assert on
 * `server/src/bin/*.ts` and `server/dist/bin/*.js`. Item 28 moved the CLI into
 * `cli/` and deleted both directories, so two groups of assertions were
 * retargeted rather than dropped:
 *
 *   1. The three SOURCE-TEXT assertions (no argv splice, no dispatcher route,
 *      no deprecation notice) read shim files that no longer exist. They are
 *      NOT ported onto `src/cli.ts` — that file legitimately contains
 *      `process.argv.slice(2)` and a deliberate filtered-argv rebuild for the
 *      legacy `mcp` positional, so the old regexes would fail on correct code.
 *      They become a STRUCTURAL lock instead: the bin points straight at the
 *      program that owns argument parsing, so there is no longer a file in
 *      between that COULD rewrite argv. That is a stronger guarantee than a
 *      source regex, and the compiled-behaviour block below still proves it
 *      end to end (`legacy === bare` fails the moment anything touches argv).
 *
 *   2. The four `supersurf-daemon` bin assertions are gone because the bin is
 *      gone: `supersurf-mcp` used to ship a duplicate reachable only through a
 *      global install, and item 28 drops it. Their absence is deliberate, not
 *      an oversight. What survives is the one thing that still must be true —
 *      the name is served by the package that owns it. That bin's argv
 *      handling is covered by `daemon/tests/main.test.ts`'s parseArgs suite.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DIST = path.resolve(__dirname, '..', 'dist');
const MCP_BIN = path.join(DIST, 'cli.js');

/** Child env with VITEST removed — daemon/src/main.ts:618 no-ops when it is set. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  return env;
}

describe('bin entrypoints — no shim can rewrite argv', () => {
  // BACKLOG #25: supersurf-mcp.ts:7 spliced 'mcp' into argv, so the documented
  // `npx supersurf-mcp@latest mcp` handed Commander a stray positional and got
  // "error: too many arguments". Item 28 removes the shim layer entirely: the
  // bin now points straight at the program that owns argument parsing, so
  // there is no longer a file in between that COULD rewrite argv. That is a
  // stronger guarantee than the old source-regex, and this asserts it.
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

  it('routes npx straight at the program, with no shim in between', () => {
    expect(pkg.bin['supersurf-mcp']).toBe('dist/cli.js');
  });

  it('ships no bin source directory a shim could reappear in', () => {
    expect(fs.existsSync(path.resolve(__dirname, '..', 'src', 'bin'))).toBe(false);
  });

  it('ships no bin directory', () => {
    expect(fs.existsSync(path.join(DIST, 'bin'))).toBe(false);
  });

  it('the entry never points a user at a name npm will never grant', () => {
    // Preserves the old "no deprecation notice" assertion: the notice it
    // banned told users to run `supersurf mcp`, and the bare `supersurf` npm
    // name is permanently squatted.
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).not.toMatch(/Deprecated/i);
  });
});

describe('supersurf-mcp bin — compiled behaviour', () => {
  const bin = MCP_BIN;

  it('has a compiled artifact committed alongside its source', () => {
    // dist/ is tracked in this repo. A source fix with no rebuild ships the
    // old broken shim in the npm tarball.
    expect(fs.existsSync(bin)).toBe(true);
  });

  it('starts the MCP server CLI instead of rejecting a stray positional', () => {
    const out = execFileSync('node', [bin, '--help'], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: 8000,
    });
    expect(out).toContain('MCP server for browser automation');
    expect(out).toContain('--script-mode');
    expect(out).not.toContain('too many arguments');
    expect(out).not.toContain('Deprecated');
  });

  it('accepts and ignores a legacy leading `mcp` positional', () => {
    // Owner ruling R1 (BACKLOG #25): `npx supersurf-mcp@latest mcp` was the
    // documented form for two releases and is baked into every MCP client
    // config written from README.md:109. It must keep working, identically to
    // the bare form and with no warning -- but the tolerance lives in cli.ts,
    // the program that owns argument parsing, NOT in the bin. The bin is still
    // a pure `import '../cli'` passthrough.
    const bare = execFileSync('node', [bin, '--help'], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: 8000,
    });
    const legacy = execFileSync('node', [bin, 'mcp', '--help'], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: 8000,
    });
    expect(legacy).toBe(bare);
    expect(legacy).not.toContain('too many arguments');
    expect(legacy).not.toContain('Deprecated');
  });
});

describe('the supersurf-daemon bin still has a home', () => {
  // supersurf-mcp used to ship a duplicate `supersurf-daemon` bin, reachable
  // only through a global install. Item 28 drops it. What must remain true is
  // that the name is still served by the package that actually owns it. Its
  // argv handling is covered by daemon/tests/main.test.ts's parseArgs suite,
  // and Task 5 smoke-runs `node daemon/dist/main.js status` by hand.
  const daemonRoot = path.resolve(__dirname, '..', '..', 'daemon');

  it('is declared by the supersurf-daemon package and its artifact is committed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(daemonRoot, 'package.json'), 'utf8'));
    expect(pkg.bin).toEqual({ 'supersurf-daemon': 'dist/main.js' });
    expect(fs.existsSync(path.join(daemonRoot, 'dist', 'main.js'))).toBe(true);
  });
});

describe('runtime hint strings name a package npm will actually serve', () => {
  const SRC = path.resolve(__dirname, '..', 'src');

  // The bare `supersurf` npm name is a permanently-squatted 0.0.1 placeholder
  // that is not this project (dispute refused 2026-06-09). Anything that tells
  // a user or an agent to run `npx supersurf ...` sends them to a stranger's
  // package. `supersurf <sub>` with no npx prefix is fine -- that is the
  // curl-installed compiled binary.
  const files = [
    'tools/playbooks.ts',
    'tools.ts',
    'bridge.ts',
    'backend/handlers.ts',
    'backend/status.ts',
    'daemon-spawn.ts',
  ];

  it.each(files)('%s never prints `npx supersurf` bare', (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    expect(src).not.toMatch(/npx supersurf(?!-)/);
  });

  it.each(files)('%s pins @latest on every npx supersurf-daemon hint', (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    const hits = src.match(/npx supersurf-daemon(@latest)?/g) ?? [];
    for (const hit of hits) {
      expect(hit).toBe('npx supersurf-daemon@latest');
    }
  });
});
