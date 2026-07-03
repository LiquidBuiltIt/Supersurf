import { describe, it, expect } from 'vitest';
import { parseProfilesArgs, PROFILES_USAGE } from '../src/bin/profiles-cli';

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
});
