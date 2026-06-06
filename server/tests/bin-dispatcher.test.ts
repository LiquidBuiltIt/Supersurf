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
});

describe('pickTarget — creds', () => {
  it('routes "creds" subcommand to creds target and strips it from argv', () => {
    const argv = ['node', 'supersurf', 'creds', 'list'];
    const result = pickTarget(argv);
    expect(result.target).toBe('creds');
    expect(result.remainingArgv).toEqual(['node', 'supersurf', 'list']);
  });

  it('routes "creds add banking --domain example.com" preserving all args', () => {
    const argv = ['node', 'supersurf', 'creds', 'add', 'banking', '--domain', 'example.com'];
    const result = pickTarget(argv);
    expect(result.target).toBe('creds');
    expect(result.remainingArgv).toEqual(['node', 'supersurf', 'add', 'banking', '--domain', 'example.com']);
  });
});

describe('HELP_TEXT', () => {
  it('documents usage and all three subcommands', () => {
    expect(HELP_TEXT).toContain('Usage:');
    expect(HELP_TEXT).toContain('mcp');
    expect(HELP_TEXT).toContain('daemon');
    expect(HELP_TEXT).toContain('creds');
  });
});
