import type { KeychainBackend, CredentialEntry } from './types';
import { KeychainError } from './types';

interface Entry {
  value: string;
  domain?: string;
}

export class InMemoryKeychainBackend implements KeychainBackend {
  private store = new Map<string, Entry>();

  async add(name: string, value: string, domain?: string): Promise<void> {
    this.store.set(name, { value, domain });
  }

  async get(name: string): Promise<string | null> {
    const entry = this.store.get(name);
    return entry ? entry.value : null;
  }

  async list(): Promise<CredentialEntry[]> {
    const items: CredentialEntry[] = [];
    for (const [name, entry] of this.store.entries()) {
      const item: CredentialEntry = { name };
      if (entry.domain !== undefined) item.domain = entry.domain;
      items.push(item);
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
  }

  async remove(name: string): Promise<void> {
    if (!this.store.has(name)) {
      throw new KeychainError(`Credential '${name}' not found`);
    }
    this.store.delete(name);
  }
}
