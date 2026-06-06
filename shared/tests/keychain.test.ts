import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryKeychainBackend } from '../keychain/inmemory';
import type { KeychainBackend } from '../keychain/types';

describe('InMemoryKeychainBackend (conformance)', () => {
  let backend: KeychainBackend;

  beforeEach(() => {
    backend = new InMemoryKeychainBackend();
  });

  it('add stores a value retrievable via get', async () => {
    await backend.add('banking', 'hunter2');
    expect(await backend.get('banking')).toBe('hunter2');
  });

  it('add with domain stores domain alongside value', async () => {
    await backend.add('banking', 'hunter2', 'example.com');
    const items = await backend.list();
    expect(items).toEqual([{ name: 'banking', domain: 'example.com' }]);
  });

  it('add without domain stores entry with no domain', async () => {
    await backend.add('github', 'ghp_token');
    const items = await backend.list();
    expect(items).toEqual([{ name: 'github' }]);
  });

  it('add overwrites existing entry with same name', async () => {
    await backend.add('banking', 'old-value', 'old.com');
    await backend.add('banking', 'new-value', 'new.com');
    expect(await backend.get('banking')).toBe('new-value');
    expect(await backend.list()).toEqual([{ name: 'banking', domain: 'new.com' }]);
  });

  it('get returns null for missing entry', async () => {
    expect(await backend.get('nonexistent')).toBeNull();
  });

  it('list returns empty array when no entries exist', async () => {
    expect(await backend.list()).toEqual([]);
  });

  it('list returns all entries sorted by name', async () => {
    await backend.add('zebra', 'v1');
    await backend.add('alpha', 'v2', 'a.com');
    await backend.add('mango', 'v3');
    expect(await backend.list()).toEqual([
      { name: 'alpha', domain: 'a.com' },
      { name: 'mango' },
      { name: 'zebra' },
    ]);
  });

  it('remove deletes an existing entry', async () => {
    await backend.add('banking', 'hunter2');
    await backend.remove('banking');
    expect(await backend.get('banking')).toBeNull();
    expect(await backend.list()).toEqual([]);
  });

  it('remove of missing entry throws KeychainError', async () => {
    await expect(backend.remove('nonexistent')).rejects.toThrow(/not found/i);
  });
});

import { getKeychainBackend } from '../keychain/index';
import { KeychainNotAvailableError } from '../keychain/types';

describe('getKeychainBackend', () => {
  it('returns MacosKeychainBackend on darwin', () => {
    const backend = getKeychainBackend('darwin');
    expect(backend.constructor.name).toBe('MacosKeychainBackend');
  });

  it('returns LinuxKeychainBackend on linux', () => {
    const backend = getKeychainBackend('linux');
    expect(backend.constructor.name).toBe('LinuxKeychainBackend');
  });

  it('throws KeychainNotAvailableError on win32', () => {
    expect(() => getKeychainBackend('win32')).toThrow(KeychainNotAvailableError);
  });

  it('throws KeychainNotAvailableError on unknown platform', () => {
    expect(() => getKeychainBackend('aix')).toThrow(KeychainNotAvailableError);
  });

  it('uses process.platform when called with no arg', () => {
    const backend = getKeychainBackend();
    if (process.platform === 'darwin') expect(backend.constructor.name).toBe('MacosKeychainBackend');
    else if (process.platform === 'linux') expect(backend.constructor.name).toBe('LinuxKeychainBackend');
  });
});
