import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pickTarget, HELP_TEXT, dispatch } from '../src/dispatcher';
import { VERSION } from '../src/version';

/**
 * `dispatch()` was never exercised with an `mcp` or `daemon` target, and
 * `shellOut()` itself was never invoked, in any test before this one — the
 * direct reason a hanging-promise regression reached a commit. Mocking
 * 'node:child_process' here (rather than mocking './shell-out') exercises the
 * REAL shellOut implementation, which is the point.
 */
const spawned: { cmd: string; args: string[]; opts: any }[] = [];
const childExit: { code: number | null; signal: NodeJS.Signals | null } = { code: 0, signal: null };

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts: any) => {
      spawned.push({ cmd, args, opts });
      const listeners = new Map<string, (...a: any[]) => void>();
      setImmediate(() => listeners.get('exit')?.(childExit.code, childExit.signal));
      return {
        on: vi.fn((event: string, cb: (...a: any[]) => void) => { listeners.set(event, cb); }),
        kill: vi.fn(),
      } as any;
    }),
  };
});

describe('pickTarget', () => {
  it('routes "mcp" subcommand to mcp target and strips it from argv', () => {
    const argv = ['node', 'supersurf', 'mcp', '--debug'];
    const result = pickTarget(argv);
    expect(result.target).toBe('mcp');
    expect(result.remainingArgv).toEqual(['node', 'supersurf', '--debug']);
  });

  it('routes "daemon" subcommand to daemon target and strips it from argv', () => {
    const argv = ['node', 'supersurf', 'daemon', 'status', '--verbose'];
    const result = pickTarget(argv);
    expect(result.target).toBe('daemon');
    expect(result.remainingArgv).toEqual(['node', 'supersurf', 'status', '--verbose']);
  });

  it('returns the help target when no subcommand is given (bare invocation)', () => {
    const argv = ['node', 'supersurf'];
    const result = pickTarget(argv);
    expect(result.target).toBe('help');
  });

  it('returns the help target when the first arg is an option flag, not a subcommand', () => {
    const argv = ['node', 'supersurf', '--debug'];
    const result = pickTarget(argv);
    expect(result.target).toBe('help');
  });

  it('returns the help target for an unrecognized command', () => {
    const argv = ['node', 'supersurf', 'frobnicate'];
    const result = pickTarget(argv);
    expect(result.target).toBe('help');
  });

  it('passes through additional args after the subcommand untouched', () => {
    const argv = ['node', 'supersurf', 'daemon', 'restart', '--port', '6666', '--debug'];
    const result = pickTarget(argv);
    expect(result.target).toBe('daemon');
    expect(result.remainingArgv).toEqual(['node', 'supersurf', 'restart', '--port', '6666', '--debug']);
  });

  it('routes "profiles" subcommand to profiles target and strips it from argv', () => {
    const argv = ['node', 'supersurf', 'profiles', 'open', 'dev'];
    const result = pickTarget(argv);
    expect(result.target).toBe('profiles');
    expect(result.remainingArgv).toEqual(['node', 'supersurf', 'open', 'dev']);
  });

  it('routes "export" subcommand to export target and strips it from argv', () => {
    const argv = ['node', 'supersurf', 'export'];
    const result = pickTarget(argv);
    expect(result.target).toBe('export');
    expect(result.remainingArgv).toEqual(['node', 'supersurf']);
  });

  it('routes the playbook subcommand', () => {
    const plan = pickTarget(['node', 'supersurf', 'playbook', 'ls']);
    expect(plan.target).toBe('playbook');
    expect(plan.remainingArgv).toEqual(['node', 'supersurf', 'ls']);
  });

  it('lists playbook in the help text', () => {
    expect(HELP_TEXT).toContain('playbook');
  });
});

describe('pickTarget — creds is delisted', () => {
  it('no longer recognizes "creds" and routes it to the help target', () => {
    const argv = ['node', 'supersurf', 'creds', 'list'];
    const result = pickTarget(argv);
    expect(result.target).toBe('help');
  });
});

describe('HELP_TEXT', () => {
  it('documents usage and the public subcommands, not the delisted creds', () => {
    expect(HELP_TEXT).toContain('Usage:');
    expect(HELP_TEXT).toContain('mcp');
    expect(HELP_TEXT).toContain('daemon');
    expect(HELP_TEXT).not.toContain('creds');
  });

  it('documents the profiles command', () => {
    expect(HELP_TEXT).toContain('profiles');
    expect(HELP_TEXT).toContain('open <name>');
  });

  it('documents the export command', () => {
    expect(HELP_TEXT).toContain('export');
  });

  // BACKLOG #25: the example printed `npx supersurf-mcp@latest mcp`, the exact
  // form that crashed. This help text belongs to the `supersurf` binary, so its
  // examples use the binary's own form.
  it('does not print the argv-splicing npx form that used to crash', () => {
    expect(HELP_TEXT).not.toContain('npx supersurf-mcp@latest mcp');
  });

  it('shows the binary-native mcp example', () => {
    expect(HELP_TEXT).toContain('supersurf mcp');
    // `npx supersurf` is a permanently-squatted package that is not us.
    expect(HELP_TEXT).not.toMatch(/npx supersurf(@|\s|$)/);
  });
});

describe('dispatch — shells out for the mcp and daemon targets', () => {
  const savedArgv = process.argv;
  let exitCode: number | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawned.length = 0;
    childExit.code = 0;
    childExit.signal = null;
    exitCode = undefined;
    // process.exit really does exit in dispatch() for these two targets, so
    // it must be stubbed to observe the code instead of killing the runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      return undefined as never;
    }) as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.argv = savedArgv;
  });

  it('mcp target spawns the pinned supersurf-mcp package with inherited stdio, and exits with the child code', async () => {
    childExit.code = 5;
    await dispatch(['node', 'supersurf', 'mcp', '--debug']);
    expect(spawned[0].cmd).toBe('npx');
    expect(spawned[0].args).toEqual(['--yes', `supersurf-mcp@${VERSION}`, '--debug']);
    expect(spawned[0].opts).toMatchObject({ stdio: 'inherit' });
    expect(exitCode).toBe(5);
  });

  it('daemon target spawns the pinned supersurf-daemon package with inherited stdio, and exits with the child code', async () => {
    childExit.code = 2;
    await dispatch(['node', 'supersurf', 'daemon', 'status']);
    expect(spawned[0].cmd).toBe('npx');
    expect(spawned[0].args).toEqual(['--yes', `supersurf-daemon@${VERSION}`, 'status']);
    expect(spawned[0].opts).toMatchObject({ stdio: 'inherit' });
    expect(exitCode).toBe(2);
  });

  // The highest-value assertion in this suite: a compiled binary that
  // resolved `@latest` could launch a protocol version it does not
  // understand. This must stay pinned to the binary's own VERSION.
  it('never resolves either target to @latest', async () => {
    await dispatch(['node', 'supersurf', 'mcp']);
    const mcpTarget = spawned[0].args[1];
    expect(mcpTarget.endsWith(`@${VERSION}`)).toBe(true);
    expect(mcpTarget).not.toContain('@latest');

    spawned.length = 0;
    await dispatch(['node', 'supersurf', 'daemon']);
    const daemonTarget = spawned[0].args[1];
    expect(daemonTarget.endsWith(`@${VERSION}`)).toBe(true);
    expect(daemonTarget).not.toContain('@latest');
  });
});

/**
 * BACKLOG #39. `--version` used to fall through `pickTarget` to the
 * unrecognized-command branch: usage on stderr, exit 1. The version string was
 * already imported in the same file for the npx pin.
 *
 * The output contract is the point of these tests. `install.sh` reports the
 * version it just installed with a bare `V=$(supersurf --version)`, so stdout
 * must carry the version and nothing else — no `supersurf ` prefix, and no
 * upgrade notice sharing the stream.
 */
describe('pickTarget — version flags', () => {
  it('routes --version to the version target instead of the usage-error branch', () => {
    expect(pickTarget(['node', 'supersurf', '--version']).target).toBe('version');
  });

  it('routes the -v short flag the same way', () => {
    expect(pickTarget(['node', 'supersurf', '-v']).target).toBe('version');
  });

  it('documents the flags in the help text', () => {
    expect(HELP_TEXT).toContain('--version');
  });
});

describe('dispatch — the version target', () => {
  let logged: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let exited: number | undefined;

  beforeEach(() => {
    logged = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
      logged.push(a.join(' '));
    });
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exited = undefined;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited = code;
      return undefined as never;
    }) as any);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints the bare version on stdout and does not exit non-zero', async () => {
    await dispatch(['node', 'supersurf', '--version']);
    expect(logged).toEqual([VERSION]);
    expect(errSpy).not.toHaveBeenCalled();
    expect(exited).toBeUndefined();
  });

  it('prints nothing but the version — no name prefix, nothing a script must strip', async () => {
    await dispatch(['node', 'supersurf', '-v']);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe(VERSION);
    expect(logged[0]).not.toContain('supersurf');
  });
});
