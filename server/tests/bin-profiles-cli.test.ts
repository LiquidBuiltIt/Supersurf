import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/daemon-client', () => ({
  // Vitest 4 requires a `function`/`class` implementation for a mock that's
  // invoked with `new` (an arrow-function impl throws "is not a constructor").
  DaemonClient: vi.fn(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendCmd: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('../src/daemon-spawn', () => ({
  ensureDaemon: vi.fn().mockResolvedValue(undefined),
  getSockPath: vi.fn().mockReturnValue('/tmp/test-daemon.sock'),
}));

import { parseProfilesArgs, runProfilesCli, PROFILES_USAGE } from '../src/bin/profiles-cli';
import { DaemonClient } from '../src/daemon-client';

let lastSendCmd: ReturnType<typeof vi.fn>;

/** Reconfigure the mocked DaemonClient's `sendCmd` for the next `withCliDaemonClient` call. */
function mockSendCmd(impl: (...args: any[]) => Promise<any>): void {
  lastSendCmd = vi.fn(impl);
  (DaemonClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendCmd: lastSendCmd,
    };
  });
}

describe('parseProfilesArgs', () => {
  // argv arrives dispatcher-stripped: ['node', 'supersurf', <cmd>, ...]
  it('parses ls', () => {
    expect(parseProfilesArgs(['node', 'supersurf', 'ls'])).toEqual({ cmd: 'ls' });
  });

  it('parses open with a profile name', () => {
    expect(parseProfilesArgs(['node', 'supersurf', 'open', 'dev'])).toEqual({ cmd: 'open', profile: 'dev' });
  });

  it('rejects open without a profile name', () => {
    const result = parseProfilesArgs(['node', 'supersurf', 'open']);
    expect(result.cmd).toBe('help');
    expect((result as any).error).toContain('requires a profile name');
  });

  it('parses create with a profile name', () => {
    expect(parseProfilesArgs(['node', 'supersurf', 'create', 'dev'])).toEqual({ cmd: 'create', name: 'dev' });
  });

  it('rejects create without a profile name', () => {
    const result = parseProfilesArgs(['node', 'supersurf', 'create']);
    expect(result.cmd).toBe('help');
    expect((result as any).error).toContain('requires a profile name');
  });

  it('parses rm with a profile name', () => {
    expect(parseProfilesArgs(['node', 'supersurf', 'rm', 'dev'])).toEqual({ cmd: 'rm', name: 'dev' });
  });

  it('parses "delete" as an alias for rm', () => {
    expect(parseProfilesArgs(['node', 'supersurf', 'delete', 'dev'])).toEqual({ cmd: 'rm', name: 'dev' });
  });

  it('rejects rm without a profile name', () => {
    const result = parseProfilesArgs(['node', 'supersurf', 'rm']);
    expect(result.cmd).toBe('help');
    expect((result as any).error).toContain('requires a profile name');
  });

  it('parses rename with old and new names', () => {
    expect(parseProfilesArgs(['node', 'supersurf', 'rename', 'old', 'new']))
      .toEqual({ cmd: 'rename', oldName: 'old', newName: 'new' });
  });

  it('rejects rename missing the new name', () => {
    const result = parseProfilesArgs(['node', 'supersurf', 'rename', 'old']);
    expect(result.cmd).toBe('help');
    expect((result as any).error).toContain('requires <old> and <new> names');
  });

  it('rejects rename with no names at all', () => {
    const result = parseProfilesArgs(['node', 'supersurf', 'rename']);
    expect(result.cmd).toBe('help');
    expect((result as any).error).toContain('requires <old> and <new> names');
  });

  it('treats bare/--help/-h as help without error', () => {
    expect(parseProfilesArgs(['node', 'supersurf'])).toEqual({ cmd: 'help' });
    expect(parseProfilesArgs(['node', 'supersurf', '--help'])).toEqual({ cmd: 'help' });
    expect(parseProfilesArgs(['node', 'supersurf', '-h'])).toEqual({ cmd: 'help' });
  });

  it('flags unknown subcommands as errors', () => {
    const result = parseProfilesArgs(['node', 'supersurf', 'destroy']);
    expect(result.cmd).toBe('help');
    expect((result as any).error).toContain("unknown profiles command 'destroy'");
  });
});

describe('PROFILES_USAGE', () => {
  it('documents ls and open', () => {
    expect(PROFILES_USAGE).toContain('ls');
    expect(PROFILES_USAGE).toContain('open <name>');
  });

  it('documents create, rm, and rename', () => {
    expect(PROFILES_USAGE).toContain('create <name>');
    expect(PROFILES_USAGE).toContain('rm <name>');
    expect(PROFILES_USAGE).toContain('rename <old> <new>');
  });
});

describe('runProfilesCli', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSendCmd(async () => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  describe('create', () => {
    it('creates a profile and prints confirmation', async () => {
      mockSendCmd(async () => ({ success: true, profile: { name: 'dev', created: 'now', initialized: false } }));
      await runProfilesCli(['node', 'supersurf', 'create', 'dev']);
      expect(lastSendCmd).toHaveBeenCalledWith('profiles.create', { name: 'dev' }, 10000);
      expect(logSpy.mock.calls.flat().join('\n')).toContain("Profile 'dev' created.");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits 1 and prints the daemon error on failure', async () => {
      mockSendCmd(async () => { throw new Error("Profile 'dev' already exists"); });
      await expect(runProfilesCli(['node', 'supersurf', 'create', 'dev'])).rejects.toThrow('process.exit(1)');
      expect(errSpy.mock.calls.flat().join('\n')).toContain("Profile 'dev' already exists");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('rm', () => {
    it('removes a profile and prints confirmation', async () => {
      mockSendCmd(async () => ({ success: true }));
      await runProfilesCli(['node', 'supersurf', 'rm', 'dev']);
      expect(lastSendCmd).toHaveBeenCalledWith('profiles.delete', { name: 'dev', refuseIfRunning: true }, 10000);
      expect(logSpy.mock.calls.flat().join('\n')).toContain("Profile 'dev' removed.");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits 1 with the failsafe message when the profile is running — nothing killed, nothing deleted', async () => {
      mockSendCmd(async () => {
        throw new Error("Profile 'dev' is running (PID 1234) — stop it first.");
      });
      await expect(runProfilesCli(['node', 'supersurf', 'rm', 'dev'])).rejects.toThrow('process.exit(1)');
      expect(errSpy.mock.calls.flat().join('\n')).toContain('is running (PID 1234)');
      expect(exitSpy).toHaveBeenCalledWith(1);
      // The CLI never reports success when the daemon refuses — no "removed" message.
      expect(logSpy.mock.calls.flat().join('\n')).not.toContain('removed');
    });

    it('accepts the "delete" alias', async () => {
      mockSendCmd(async () => ({ success: true }));
      await runProfilesCli(['node', 'supersurf', 'delete', 'dev']);
      expect(lastSendCmd).toHaveBeenCalledWith('profiles.delete', { name: 'dev', refuseIfRunning: true }, 10000);
    });
  });

  describe('rename', () => {
    it('renames a profile and prints confirmation', async () => {
      mockSendCmd(async () => ({ success: true, profile: { name: 'after', created: 'now', initialized: false } }));
      await runProfilesCli(['node', 'supersurf', 'rename', 'before', 'after']);
      expect(lastSendCmd).toHaveBeenCalledWith('profiles.rename', { name: 'before', newName: 'after' }, 10000);
      expect(logSpy.mock.calls.flat().join('\n')).toContain("Profile 'before' renamed to 'after'.");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('exits 1 with the failsafe message when the profile is running', async () => {
      mockSendCmd(async () => { throw new Error("Profile 'before' is running (PID 1234) — stop it first."); });
      await expect(runProfilesCli(['node', 'supersurf', 'rename', 'before', 'after'])).rejects.toThrow('process.exit(1)');
      expect(errSpy.mock.calls.flat().join('\n')).toContain('is running (PID 1234)');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 1 when active sessions block the rename', async () => {
      mockSendCmd(async () => {
        throw new Error("Cannot rename profile 'before' — active sessions are connected. Ask the user to disconnect those sessions first.");
      });
      await expect(runProfilesCli(['node', 'supersurf', 'rename', 'before', 'after'])).rejects.toThrow('process.exit(1)');
      expect(errSpy.mock.calls.flat().join('\n')).toContain('active sessions are connected');
    });
  });

  describe('help', () => {
    it('prints usage and exits 1 on a parse error', async () => {
      await expect(runProfilesCli(['node', 'supersurf', 'create'])).rejects.toThrow('process.exit(1)');
      expect(errSpy.mock.calls.flat().join('\n')).toContain('requires a profile name');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(lastSendCmd).not.toHaveBeenCalled();
    });
  });
});
