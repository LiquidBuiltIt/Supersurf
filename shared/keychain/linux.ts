import { execFileSync } from 'child_process';
import type { KeychainBackend, CredentialEntry } from './types';
import { KeychainError, SUPERSURF_SERVICE } from './types';

export class LinuxKeychainBackend implements KeychainBackend {
  async add(name: string, value: string, domain?: string): Promise<void> {
    const args = ['store', `--label=SuperSurf: ${name}`, 'service', SUPERSURF_SERVICE, 'name', name];
    if (domain !== undefined && domain !== '') {
      args.push('domain', domain);
    }
    try {
      execFileSync('secret-tool', args, {
        input: value,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new KeychainError(`Failed to add credential '${name}'`, err);
    }
  }

  async get(name: string): Promise<string | null> {
    try {
      const out = execFileSync(
        'secret-tool',
        ['lookup', 'service', SUPERSURF_SERVICE, 'name', name],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return out.toString('utf8').replace(/\r?\n$/, '');
    } catch (err: any) {
      if (err?.status === 1) return null;
      throw new KeychainError(`Failed to get credential '${name}'`, err);
    }
  }

  async list(): Promise<CredentialEntry[]> {
    let output: string;
    try {
      output = execFileSync(
        'secret-tool',
        ['search', '--all', '--unlock', 'service', SUPERSURF_SERVICE],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      ).toString('utf8');
    } catch (err: any) {
      if (err?.status === 1) return [];
      throw new KeychainError('Failed to list credentials', err);
    }
    return parseSecretToolSearch(output);
  }

  async remove(name: string): Promise<void> {
    const existing = await this.get(name);
    if (existing === null) {
      throw new KeychainError(`Credential '${name}' not found`);
    }
    try {
      execFileSync(
        'secret-tool',
        ['clear', 'service', SUPERSURF_SERVICE, 'name', name],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      throw new KeychainError(`Failed to remove credential '${name}'`, err);
    }
  }
}

function parseSecretToolSearch(output: string): CredentialEntry[] {
  const items: CredentialEntry[] = [];
  const blocks = output.split(/^\[/m).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const nameMatch = block.match(/^attribute\.name\s*=\s*(.+)$/m);
    if (!nameMatch) continue;
    const domainMatch = block.match(/^attribute\.domain\s*=\s*(.+)$/m);
    const entry: CredentialEntry = { name: nameMatch[1].trim() };
    if (domainMatch && domainMatch[1].trim() !== '') {
      entry.domain = domainMatch[1].trim();
    }
    items.push(entry);
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}
