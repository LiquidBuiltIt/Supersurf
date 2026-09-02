/**
 * These tests run the REAL compiled `dist/cli.js`, on purpose.
 *
 * The defect this file exists to lock was invisible to every mock-`spawn` test:
 * the caller's argv was asserted against nothing that could parse it, and
 * `supersurf-mcp playbook run …` answered `error: unknown option '--param'`.
 * A test that only re-states the caller's intent cannot catch that. So these
 * execute the artifact and read what it actually printed.
 *
 * `dist/` is tracked in this repo, so a source fix with no rebuild ships the
 * old broken program in the npm tarball — running the artifact catches that too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.resolve(__dirname, '..', 'dist', 'cli.js');

let home: string;
beforeAll(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cli-home-')); });
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

/**
 * Child env with VITEST removed and HOME redirected: the CLI touches
 * `~/.supersurf` (version state, config scaffold) and must not write into the
 * developer's real one from a test run.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: home };
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  return env;
}

/** Run the CLI to completion, returning its streams and exit code either way. */
function run(args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: any) {
    return {
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
      code: typeof err.status === 'number' ? err.status : -1,
    };
  }
}

describe('compiled cli.js — `playbook run` parses its own argv', () => {
  it('has a compiled artifact committed alongside its source', () => {
    expect(fs.existsSync(CLI)).toBe(true);
  });

  // Both forms below are verbatim reproductions of the reported defect.
  // `--param` was rejected as an unknown option; the bare form was rejected as
  // "too many arguments. Expected 0 arguments but got 3."
  it.each([
    ['with --param', ['playbook', 'run', 'x', '--param', 'a=b']],
    ['bare', ['playbook', 'run', 'x']],
    ['full caller argv', ['playbook', 'run', 'x', '--param', 'a=b', '--profile', 'p', '--json']],
  ])('%s: reaches the runner instead of an argv error', (_label, args) => {
    const r = run(args as string[]);
    const all = r.stdout + r.stderr;
    expect(all).not.toContain('unknown option');
    expect(all).not.toContain('too many arguments');
    expect(all).not.toContain('unknown command');
    // It got far enough to look the name up in the registry and not find it.
    expect(all).toContain("No playbook named 'x'");
    expect(r.code).toBe(1);
  });

  it('declares exactly the flags cli/src/playbook-cli.ts shells out with', () => {
    const help = run(['playbook', 'run', '--help']).stdout;
    expect(help).toContain('--param');
    expect(help).toContain('--profile');
    expect(help).toContain('--json');
    expect(help).toContain('<name>');
  });

  it('accepts --param repeated, the way the caller emits it', () => {
    const all = run(['playbook', 'run', 'x', '--param', 'a=b', '--param', 'c=d']);
    expect(all.stdout + all.stderr).not.toContain('unknown option');
    expect(all.stderr).toContain("No playbook named 'x'");
  });

  it('registers `run` and nothing else under `playbook`', () => {
    // ls/inspect/validate/migrate live in the compiled binary and must not be
    // duplicated here — a second playbook CLI is two sources of truth.
    const help = run(['playbook', '--help']).stdout;
    expect(help).toContain('run');
    for (const sub of ['ls', 'inspect', 'validate', 'migrate']) {
      expect(help).not.toMatch(new RegExp(`^\\s+${sub}\\b`, 'm'));
    }
  });
});

describe('compiled cli.js — the MCP entrypoint survives the new subcommand', () => {
  it('still describes itself as the MCP server and still offers --script-mode', () => {
    const help = run(['--help']).stdout;
    expect(help).toContain('MCP server for browser automation');
    expect(help).toContain('--script-mode');
    expect(help).not.toContain('too many arguments');
  });

  // Owner ruling R1 (BACKLOG #25): the legacy `npx supersurf-mcp@latest mcp`
  // form is baked into shipped MCP client configs. cli.ts drops exactly one
  // leading `mcp` positional, so the two forms must stay byte-identical even
  // now that a real `playbook` subcommand exists next to it.
  it('treats a leading `mcp` positional identically to the bare form', () => {
    const bare = run(['--help']).stdout;
    const legacy = run(['mcp', '--help']).stdout;
    expect(legacy).toBe(bare);
    expect(legacy).not.toContain('unknown command');
    expect(legacy).not.toContain('too many arguments');
  });

  // The load-bearing property of adding a subcommand to a program that has a
  // root action: Commander must STILL run the root action when no subcommand
  // is named. If it stopped, `npx supersurf-mcp` would print help instead of
  // starting a server, and every installed MCP client would break at once.
  it('bare invocation still boots the MCP server and answers `initialize`', async () => {
    const child = spawn('node', [CLI], {
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pending = new Promise<any>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`no initialize reply; stdout=${buf}`)), 20000);
      child.stdout.on('data', (d) => {
        buf += String(d);
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1) { clearTimeout(timer); resolve(msg); return; }
          } catch { /* partial line — wait for more */ }
        }
      });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited early (code=${code}); stdout=${buf}`)); });
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'p13-regression-lock', version: '0' },
      },
    }) + '\n');

    let reply: any;
    try {
      reply = await pending;
    } finally {
      child.kill('SIGKILL');
    }

    expect(reply.result?.serverInfo?.name).toBeTruthy();
    expect(reply.result?.capabilities?.tools).toBeDefined();
  }, 30000);

  it('starts the MCP server from `mcp` too, not just bare', () => {
    // Cheap proxy for the boot path above: `mcp --port 5599 --help` must be
    // parsed by the root program, not rejected as an unknown command.
    const r = run(['mcp', '--port', '5599', '--help']);
    expect(r.stdout).toContain('MCP server for browser automation');
    expect(r.code).toBe(0);
  });
});
