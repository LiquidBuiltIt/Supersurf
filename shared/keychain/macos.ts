import { execFileSync } from 'child_process';
import type { KeychainBackend, CredentialEntry } from './types';
import { KeychainError, SUPERSURF_SERVICE } from './types';

const NOT_FOUND_EXIT = 44;

export class MacosKeychainBackend implements KeychainBackend {
  async add(name: string, value: string, domain?: string): Promise<void> {
    const args = ['add-generic-password', '-U', '-s', SUPERSURF_SERVICE, '-a', name];
    if (domain !== undefined && domain !== '') {
      args.push('-j', domain);
    }
    args.push('-w', value);
    try {
      execFileSync('security', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new KeychainError(`Failed to add credential '${name}'`, err);
    }
  }

  async get(name: string): Promise<string | null> {
    try {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', SUPERSURF_SERVICE, '-a', name, '-w'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return out.toString('utf8').replace(/\r?\n$/, '');
    } catch (err: any) {
      if (err?.status === NOT_FOUND_EXIT) return null;
      throw new KeychainError(`Failed to get credential '${name}'`, err);
    }
  }

  async list(): Promise<CredentialEntry[]> {
    let dump: string;
    try {
      dump = execFileSync('security', ['dump-keychain'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
    } catch (err) {
      throw new KeychainError('Failed to dump keychain', err);
    }
    return parseDumpKeychain(dump);
  }

  async remove(name: string): Promise<void> {
    try {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', SUPERSURF_SERVICE, '-a', name],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err: any) {
      if (err?.status === NOT_FOUND_EXIT) {
        throw new KeychainError(`Credential '${name}' not found`);
      }
      throw new KeychainError(`Failed to remove credential '${name}'`, err);
    }
  }
}

function parseDumpKeychain(dump: string): CredentialEntry[] {
  const items: CredentialEntry[] = [];
  const blocks = dump.split(/^keychain: /m);
  for (const block of blocks) {
    if (!block.includes('class: "genp"')) continue;
    const svceMatch = block.match(/"svce"<blob>="([^"]*)"/);
    if (!svceMatch || svceMatch[1] !== SUPERSURF_SERVICE) continue;
    const acctMatch = block.match(/"acct"<blob>="([^"]*)"/);
    if (!acctMatch) continue;
    const cmntMatch = block.match(/"cmnt"<blob>=(?:"([^"]*)"|<NULL>)/);
    const entry: CredentialEntry = { name: acctMatch[1] };
    if (cmntMatch && cmntMatch[1] !== undefined && cmntMatch[1] !== '') {
      entry.domain = cmntMatch[1];
    }
    items.push(entry);
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}
