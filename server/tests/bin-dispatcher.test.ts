import { describe, it, expect } from 'vitest';
import { pickTarget, HELP_TEXT } from '../src/bin/dispatcher';

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
});
