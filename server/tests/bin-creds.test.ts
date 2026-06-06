import { describe, it, expect } from 'vitest';
import { buildCredsProgram } from '../src/bin/creds';

describe('buildCredsProgram', () => {
  it('returns a commander program named "supersurf creds"', () => {
    const program = buildCredsProgram();
    expect(program.name()).toBe('supersurf creds');
  });

  it('registers add subcommand', () => {
    const program = buildCredsProgram();
    const cmd = program.commands.find((c) => c.name() === 'add');
    expect(cmd).toBeDefined();
  });

  it('registers list subcommand', () => {
    const program = buildCredsProgram();
    const cmd = program.commands.find((c) => c.name() === 'list');
    expect(cmd).toBeDefined();
  });

  it('registers rm subcommand', () => {
    const program = buildCredsProgram();
    const cmd = program.commands.find((c) => c.name() === 'rm');
    expect(cmd).toBeDefined();
  });

  it('add subcommand accepts <name> positional', () => {
    const program = buildCredsProgram();
    const cmd = program.commands.find((c) => c.name() === 'add')!;
    const usage = cmd.usage();
    expect(usage).toContain('<name>');
  });

  it('add subcommand has --domain option', () => {
    const program = buildCredsProgram();
    const cmd = program.commands.find((c) => c.name() === 'add')!;
    const opt = cmd.options.find((o) => o.long === '--domain');
    expect(opt).toBeDefined();
  });

  it('rm subcommand accepts <name> positional', () => {
    const program = buildCredsProgram();
    const cmd = program.commands.find((c) => c.name() === 'rm')!;
    expect(cmd.usage()).toContain('<name>');
  });
});

import { runAdd } from '../src/bin/creds';
import { InMemoryKeychainBackend } from 'shared';

describe('runAdd', () => {
  it('adds a credential with name+value+domain', async () => {
    const backend = new InMemoryKeychainBackend();
    const stdout: string[] = [];
    await runAdd('banking', 'example.com', {
      backend,
      readSecret: async () => 'hunter2',
      log: (s) => stdout.push(s),
    });
    expect(await backend.get('banking')).toBe('hunter2');
    expect(await backend.list()).toEqual([{ name: 'banking', domain: 'example.com' }]);
    expect(stdout.some((line) => line.includes('Added'))).toBe(true);
  });

  it('adds a credential without domain when not provided', async () => {
    const backend = new InMemoryKeychainBackend();
    await runAdd('github', undefined, {
      backend,
      readSecret: async () => 'ghp_token',
      log: () => {},
    });
    expect(await backend.list()).toEqual([{ name: 'github' }]);
  });

  it('rejects empty name', async () => {
    const backend = new InMemoryKeychainBackend();
    await expect(
      runAdd('', undefined, {
        backend,
        readSecret: async () => 'x',
        log: () => {},
      }),
    ).rejects.toThrow(/name.*required/i);
  });

  it('rejects empty value from stdin', async () => {
    const backend = new InMemoryKeychainBackend();
    await expect(
      runAdd('banking', undefined, {
        backend,
        readSecret: async () => '',
        log: () => {},
      }),
    ).rejects.toThrow(/value.*required/i);
  });
});

import { runList, runRemove } from '../src/bin/creds';

describe('runList', () => {
  it('prints "(no credentials stored)" when empty', async () => {
    const backend = new InMemoryKeychainBackend();
    const stdout: string[] = [];
    await runList({ backend, log: (s) => stdout.push(s) });
    expect(stdout.join('\n')).toMatch(/no credentials/i);
  });

  it('prints a name+domain table when entries exist', async () => {
    const backend = new InMemoryKeychainBackend();
    await backend.add('banking', 'v', 'example.com');
    await backend.add('github', 'v');
    const stdout: string[] = [];
    await runList({ backend, log: (s) => stdout.push(s) });
    const out = stdout.join('\n');
    expect(out).toContain('banking');
    expect(out).toContain('example.com');
    expect(out).toContain('github');
    expect(out).toContain('(none)');
  });

  it('never prints values', async () => {
    const backend = new InMemoryKeychainBackend();
    await backend.add('banking', 'super-secret-value', 'example.com');
    const stdout: string[] = [];
    await runList({ backend, log: (s) => stdout.push(s) });
    expect(stdout.join('\n')).not.toContain('super-secret-value');
  });
});

describe('runRemove', () => {
  it('removes an existing credential', async () => {
    const backend = new InMemoryKeychainBackend();
    await backend.add('banking', 'v');
    const stdout: string[] = [];
    await runRemove('banking', { backend, log: (s) => stdout.push(s) });
    expect(await backend.list()).toEqual([]);
    expect(stdout.join('\n')).toMatch(/removed/i);
  });

  it('throws KeychainError when name does not exist', async () => {
    const backend = new InMemoryKeychainBackend();
    await expect(
      runRemove('nonexistent', { backend, log: () => {} }),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects empty name', async () => {
    const backend = new InMemoryKeychainBackend();
    await expect(
      runRemove('', { backend, log: () => {} }),
    ).rejects.toThrow(/name.*required/i);
  });
});
