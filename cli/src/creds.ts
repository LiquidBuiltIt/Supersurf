#!/usr/bin/env node
import { Command } from 'commander';
import { getKeychainBackend, KeychainError } from 'shared';
import type { KeychainBackend } from 'shared';

export interface RunOpts {
  backend?: KeychainBackend;
  readSecret?: () => Promise<string>;
  log?: (msg: string) => void;
}

export function buildCredsProgram(): Command {
  const program = new Command();
  program
    .name('supersurf creds')
    .description('Manage SuperSurf credentials in the OS keychain');

  program
    .command('add')
    .description('Add a credential (reads value from stdin)')
    .argument('<name>', 'credential name (e.g., "banking", "github")')
    .option('--domain <domain>', 'optional domain associated with the credential')
    .action(async (name: string, opts: { domain?: string }) => {
      await runAdd(name, opts.domain);
    });

  program
    .command('list')
    .description('List all stored credential names (values never shown)')
    .action(async () => {
      await runList();
    });

  program
    .command('rm')
    .description('Remove a credential')
    .argument('<name>', 'credential name to remove')
    .action(async (name: string) => {
      await runRemove(name);
    });

  return program;
}

export async function runAdd(name: string, domain?: string, opts: RunOpts = {}): Promise<void> {
  if (!name || name.trim() === '') {
    throw new Error('Credential name is required');
  }
  const backend = opts.backend ?? getKeychainBackend();
  const readSecret = opts.readSecret ?? readSecretFromStdin;
  const log = opts.log ?? console.log;

  log(`Enter value for '${name}' (input hidden):`);
  const value = await readSecret();
  if (!value || value === '') {
    throw new Error('Credential value is required');
  }
  await backend.add(name, value, domain);
  log(`Added credential '${name}'${domain ? ` (domain: ${domain})` : ''}`);
}

export async function runList(opts: RunOpts = {}): Promise<void> {
  const backend = opts.backend ?? getKeychainBackend();
  const log = opts.log ?? console.log;
  const items = await backend.list();
  if (items.length === 0) {
    log('(no credentials stored)');
    return;
  }
  const nameWidth = Math.max(4, ...items.map((i) => i.name.length));
  const header = `${'Name'.padEnd(nameWidth)}  Domain`;
  log(header);
  log('-'.repeat(header.length));
  for (const item of items) {
    log(`${item.name.padEnd(nameWidth)}  ${item.domain ?? '(none)'}`);
  }
}

export async function runRemove(name: string, opts: RunOpts = {}): Promise<void> {
  if (!name || name.trim() === '') {
    throw new Error('Credential name is required');
  }
  const backend = opts.backend ?? getKeychainBackend();
  const log = opts.log ?? console.log;
  await backend.remove(name);
  log(`Removed credential '${name}'`);
}

function readSecretFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => { buf += chunk; });
      stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
      stdin.on('error', reject);
      return;
    }
    let buf = '';
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (key: string) => {
      if (key === '\n' || key === '\r' || key === '') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (key === '') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.exit(1);
      } else if (key === '' || key === '\b') {
        if (buf.length > 0) buf = buf.slice(0, -1);
      } else {
        buf += key;
      }
    };
    stdin.on('data', onData);
  });
}

export async function runCredsProgram(argv: string[]): Promise<void> {
  const program = buildCredsProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof KeychainError) {
      console.error(`[creds] ${err.message}`);
    } else {
      console.error(`[creds] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  runCredsProgram(process.argv).catch(() => {
    // error already printed in runCredsProgram
  });
}
