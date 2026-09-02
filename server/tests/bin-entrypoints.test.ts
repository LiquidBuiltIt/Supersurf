import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SRC_BIN = path.resolve(__dirname, '..', 'src', 'bin');
const DIST_BIN = path.resolve(__dirname, '..', 'dist', 'bin');

/** Child env with VITEST removed — daemon/src/main.ts:618 no-ops when it is set. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  return env;
}

describe('bin entrypoints — no argv rewriting', () => {
  // BACKLOG #25: supersurf-mcp.ts:7 spliced 'mcp' into argv, so a user who typed
  // the documented `npx supersurf-mcp@latest mcp` handed Commander a stray
  // positional and got "error: too many arguments. Expected 0 arguments but got 1."
  // A bin owns exactly one thing and must never edit the argv it was handed.
  it.each(['supersurf-mcp.ts', 'supersurf-daemon.ts'])(
    '%s does not splice a subcommand into process.argv',
    (file) => {
      const src = fs.readFileSync(path.join(SRC_BIN, file), 'utf8');
      expect(src).not.toMatch(/process\.argv\.slice\(2\)/);
      expect(src).not.toMatch(/\[\s*process\.argv\[0\]/);
    },
  );

  it('supersurf-mcp.ts does not route through the dispatcher', () => {
    const src = fs.readFileSync(path.join(SRC_BIN, 'supersurf-mcp.ts'), 'utf8');
    expect(src).not.toContain('dispatcher');
  });

  it('no bin prints a deprecation notice pointing at a name npm will never grant', () => {
    for (const file of ['supersurf-mcp.ts', 'supersurf-daemon.ts', 'supersurf.ts']) {
      const src = fs.readFileSync(path.join(SRC_BIN, file), 'utf8');
      expect(src).not.toMatch(/Deprecated/i);
    }
  });
});

describe('supersurf-mcp bin — compiled behaviour', () => {
  const bin = path.join(DIST_BIN, 'supersurf-mcp.js');

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

describe('supersurf-daemon bin — compiled behaviour', () => {
  const bin = path.join(DIST_BIN, 'supersurf-daemon.js');

  it('has a compiled artifact committed alongside its source', () => {
    expect(fs.existsSync(bin)).toBe(true);
  });

  it('passes a bare subcommand straight through to the daemon CLI', () => {
    // `status` is the only daemon subcommand that is safe to run in a test: it
    // queries ~/.supersurf/daemon.sock read-only and never spawns anything.
    // A live daemon that answers the query successfully prints
    // `SuperSurf Daemon v...`; no daemon (or a stale PID file) prints
    // `Daemon not running` and exits 1. Either proves argv reached the real
    // daemon CLI untouched, which is all this test needs to lock.
    let out = '';
    try {
      out = execFileSync('node', [bin, 'status'], {
        encoding: 'utf8',
        env: childEnv(),
        timeout: 8000,
      });
    } catch (err: any) {
      out = String(err.stdout ?? '');
    }
    expect(out).toMatch(/Daemon (not running|running)|SuperSurf Daemon v/);
  });

  it('does not print a deprecation notice', () => {
    let stderr = '';
    try {
      stderr = String(
        execFileSync('node', [bin, 'status'], {
          encoding: 'utf8',
          env: childEnv(),
          timeout: 8000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
    } catch (err: any) {
      stderr = String(err.stderr ?? '');
    }
    expect(stderr).not.toContain('Deprecated');
  });

  it('does not consume a leading `daemon` word as a subcommand', () => {
    // The old shim spliced 'daemon' in, which only survived because
    // daemon/src/main.ts parseArgs is a tolerant token scanner that ignores
    // unknown words. Nothing should depend on that leniency any more.
    const src = fs.readFileSync(path.join(SRC_BIN, 'supersurf-daemon.ts'), 'utf8');
    expect(src).not.toContain("'daemon'");
    expect(src).not.toContain('dispatcher');
  });
});
