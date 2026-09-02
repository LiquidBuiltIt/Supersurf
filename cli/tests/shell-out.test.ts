import { describe, it, expect, vi, beforeEach } from 'vitest';
import { npxTarget, shellOut } from '../src/shell-out';
import { VERSION } from '../src/version';

describe('npxTarget', () => {
  it('pins the mcp package to the binary\'s own version', () => {
    expect(npxTarget('supersurf-mcp')).toBe(`supersurf-mcp@${VERSION}`);
  });

  it('pins the daemon package to the binary\'s own version', () => {
    expect(npxTarget('supersurf-daemon')).toBe(`supersurf-daemon@${VERSION}`);
  });

  it('never emits @latest', () => {
    expect(npxTarget('supersurf-mcp')).not.toContain('@latest');
    expect(npxTarget('supersurf-daemon')).not.toContain('@latest');
  });
});

/**
 * shellOut() itself was never invoked in any test before this — the direct
 * reason a hanging-promise regression (Promise<never>) reached a commit.
 * Mocks node:child_process the same way cli/tests/playbook-cli.test.ts does:
 * spread the real module, replace only `spawn`, track invocations in a
 * closure array, and drive the child's exit via a mutable shared object a
 * real child ALWAYS eventually fires so a caller can never hang on it.
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

describe('shellOut', () => {
  beforeEach(() => {
    spawned.length = 0;
    childExit.code = 0;
    childExit.signal = null;
  });

  it('resolves the child\'s exit code, not undefined', async () => {
    childExit.code = 7;
    const code = await shellOut('supersurf-mcp', ['--debug']);
    expect(code).toBe(7);
  });

  it('turns a signal death into 128 + signum instead of hanging or resolving 0', async () => {
    const os = await import('node:os');
    childExit.code = null;
    childExit.signal = 'SIGTERM';
    const code = await shellOut('supersurf-daemon', []);
    expect(code).toBe(128 + os.constants.signals.SIGTERM);
  });

  it('spawns npx with inherited stdio and the pinned target, never @latest', async () => {
    await shellOut('supersurf-mcp', ['run']);
    expect(spawned[0].cmd).toBe('npx');
    expect(spawned[0].opts).toMatchObject({ stdio: 'inherit' });
    const target = spawned[0].args[1];
    expect(target).toBe(`supersurf-mcp@${VERSION}`);
    expect(target.endsWith(`@${VERSION}`)).toBe(true);
    expect(target).not.toContain('@latest');
  });

  it('forwards the extra args after the pinned target', async () => {
    await shellOut('supersurf-daemon', ['start', '--port', '5555']);
    expect(spawned[0].args).toEqual(['--yes', `supersurf-daemon@${VERSION}`, 'start', '--port', '5555']);
  });
});
