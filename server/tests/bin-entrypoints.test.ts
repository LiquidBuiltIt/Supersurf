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
 *      source regex.
 *
 *      CORRECTION. An earlier revision of this comment claimed `legacy ===
 *      bare` "fails the moment anything touches argv". It does not, and the
 *      claim was load-bearing: `--help` short-circuits Commander before it
 *      validates positionals, so BOTH sides of that comparison are invariant
 *      under argv rewriting. Measured on the built artifact, bare `--help`
 *      output is byte-identical to `mcp --help` AND to a doubled `mcp mcp
 *      --help` AND to an arbitrary junk positional. A reintroduced shim that
 *      spliced `mcp` would have passed every assertion in this file.
 *
 *      What `legacy === bare` actually guarantees is narrower and still worth
 *      keeping: the OPTION-PARSING SURFACE is identical for both invocation
 *      forms — same program name, same flags, same description, and no
 *      deprecation banner on the legacy form. It says nothing about argv
 *      splicing. The assertion that covers splicing is the BOOT-PATH block
 *      below, because the boot path is the only place the symptom appears
 *      (BACKLOG #25: `error: too many arguments`).
 *
 *   2. The four `supersurf-daemon` bin assertions are gone because the bin is
 *      gone: `supersurf-mcp` used to ship a duplicate reachable only through a
 *      global install, and item 28 drops it. Their absence is deliberate, not
 *      an oversight. What survives is the one thing that still must be true —
 *      the name is served by the package that owns it. That bin's argv
 *      handling is covered by `daemon/tests/main.test.ts`'s parseArgs suite.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
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

/**
 * Run the built artifact on the BOOT path and return how it died.
 *
 * `--help` cannot see argv splicing (see the CORRECTION in the header), so the
 * only way to assert on it is to actually boot the program. Booting an MCP
 * server from a test needs two things handled:
 *
 *   1. STDIN. The server runs until stdin closes (`setupExitWatchdog` in
 *      `src/cli.ts` hooks `process.stdin.on('close')`). Inheriting a live
 *      stdin — a TTY when a human runs `npm test` — hangs forever.
 *      `stdio[0] = 'ignore'` points it at /dev/null, which closes
 *      immediately, so a clean boot self-terminates in well under a second.
 *      `scripts/smoke-pack.ts` pins stdin the same way for the same reason;
 *      do not "fix" either one to 'inherit'. `timeout` is a backstop only.
 *   2. HOME. `main()` calls `checkAndTouchVersionState`, which writes
 *      `~/.supersurf/version-state.json`. Left alone, running the test suite
 *      would stamp the real one and swallow a genuine upgrade notice, so the
 *      child gets a throwaway home. Nothing else is written and no daemon is
 *      spawned — boot lands in `passive` state and stops there.
 */
function bootProbe(args: string[]): { status: number | null; signal: string | null; stderr: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-bootprobe-'));
  try {
    const r = spawnSync('node', [MCP_BIN, ...args], {
      encoding: 'utf8',
      env: { ...childEnv(), HOME: home },
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) throw r.error;
    return { status: r.status, signal: r.signal, stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('bin entrypoints — no shim can rewrite argv', () => {
  // BACKLOG #25: supersurf-mcp.ts:7 spliced 'mcp' into argv, so the documented
  // `npx supersurf-mcp@latest mcp` handed Commander a stray positional and got
  // "error: too many arguments". Item 28 removes the shim layer entirely: the
  // bin now points straight at the program that owns argument parsing, so
  // there is no longer a file in between that COULD rewrite argv. That is a
  // stronger guarantee than the old source-regex, and this block asserts the
  // structure. The behaviour it is supposed to produce is asserted on the
  // boot path at the bottom of this file.
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
    // dist/ is tracked in this repo and `package.json:bin` points into it, so
    // this file IS what `npx supersurf-mcp` executes. A source fix landed
    // without a rebuild ships the previous build's behaviour to users.
    expect(fs.existsSync(bin)).toBe(true);
  });

  it('exposes the MCP server CLI on --help', () => {
    const out = execFileSync('node', [bin, '--help'], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: 8000,
    });
    expect(out).toContain('MCP server for browser automation');
    expect(out).toContain('--script-mode');
    expect(out).not.toContain('Deprecated');
  });

  it('offers the legacy `mcp` form the same option-parsing surface as the bare form', () => {
    // Owner ruling R1 (BACKLOG #25): `npx supersurf-mcp@latest mcp` was the
    // documented form for two releases and is baked into every MCP client
    // config written from README.md:109. It must keep working, identically to
    // the bare form and with no warning -- and the tolerance lives in cli.ts,
    // the program that owns argument parsing, in the filtered-argv rebuild at
    // the bottom of that file.
    //
    // SCOPE, because this comparison has been over-claimed before: `--help`
    // returns before Commander validates positionals, so an equal result here
    // proves the two forms present the SAME OPTIONS, and nothing about argv
    // splicing. The boot-path block below is what proves that.
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
    expect(legacy).not.toContain('Deprecated');
  });
});

describe('supersurf-mcp bin — boot path (where argv splicing is visible)', () => {
  // BACKLOG #25's symptom is a Commander positional-count rejection, and
  // Commander only counts positionals on the way into an action handler.
  // Every `--help` assertion in this file is therefore blind to it. These
  // three run the artifact for real.

  it('boots clean with no arguments', () => {
    const r = bootProbe([]);
    expect(r.stderr).not.toContain('too many arguments');
    expect(r.status).toBe(0);
  });

  it('boots clean with the legacy leading `mcp` positional', () => {
    const r = bootProbe(['mcp']);
    expect(r.stderr).not.toContain('too many arguments');
    expect(r.status).toBe(0);
  });

  it('rejects a doubled `mcp`, proving the two probes above can fail', () => {
    // A NEGATIVE CONTROL, not a feature. `mcp mcp` simulates a reintroduced
    // shim splicing 'mcp' on top of the user's own: cli.ts drops exactly one
    // leading 'mcp', the second survives as a stray positional, and Commander
    // rejects it. That is verbatim the bug.
    //
    // Its job is to keep the two probes above honest. `not.toContain` passes
    // on empty output, so a probe that silently stopped launching the child
    // would report "clean" forever — which is precisely how the `--help`
    // assertions this block replaces came to give false assurance. If this
    // test ever goes green-by-passing-nothing, delete the block; do not
    // relax it.
    const r = bootProbe(['mcp', 'mcp']);
    expect(r.stderr).toContain('too many arguments');
    expect(r.status).toBe(1);
  });
});

describe('the supersurf-daemon bin still has a home', () => {
  // supersurf-mcp used to ship a duplicate `supersurf-daemon` bin, reachable
  // only through a global install. Item 28 drops it. What must remain true is
  // that the name is still served by the package that actually owns it. Its
  // argv handling is covered by daemon/tests/main.test.ts's parseArgs suite.
  const daemonRoot = path.resolve(__dirname, '..', '..', 'daemon');

  it('is declared by the supersurf-daemon package and its artifact is committed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(daemonRoot, 'package.json'), 'utf8'));
    expect(pkg.bin).toEqual({ 'supersurf-daemon': 'dist/main.js' });
    expect(fs.existsSync(path.join(daemonRoot, 'dist', 'main.js'))).toBe(true);
  });

  it('the committed bundle actually boots and answers `status`', () => {
    // Restores the EXECUTION the deleted server-side shim test performed. The
    // structural test above only stats the file, and dist/main.js is a BUNDLE
    // (tsc + shared.bundle.ts) -- a bundler regression, a syntax error or a
    // lost exec bit would otherwise leave this suite green. `status` reads the
    // socket and spawns nothing, so it is safe with or without a live daemon.
    const bin = path.join(daemonRoot, 'dist', 'main.js');
    const r = spawnSync('node', [bin, 'status'], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.error, `spawn failed: ${r.error?.message}`).toBeUndefined();
    expect(out).toMatch(/SuperSurf Daemon|Daemon (is )?not running/i);
  });
});

describe('runtime hint strings name a package npm will actually serve', () => {
  const SRC = path.resolve(__dirname, '..', 'src');

  // The bare `supersurf` npm name is a permanently-squatted 0.0.1 placeholder
  // that is not this project (dispute refused 2026-06-09). Anything that tells
  // a user or an agent to run `npx supersurf ...` sends them to a stranger's
  // package. `supersurf <sub>` with no npx prefix is fine -- that is the
  // standalone compiled binary built from cli/.
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
