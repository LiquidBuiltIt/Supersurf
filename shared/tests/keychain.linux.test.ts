import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { LinuxKeychainBackend } from '../keychain/linux';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExec = vi.mocked(execFileSync);

describe('LinuxKeychainBackend', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  describe('add', () => {
    it('invokes secret-tool store with service+name+domain attributes and password via stdin', async () => {
      mockExec.mockReturnValueOnce(Buffer.from(''));
      const backend = new LinuxKeychainBackend();
      await backend.add('banking', 'hunter2', 'example.com');
      expect(mockExec).toHaveBeenCalledWith(
        'secret-tool',
        ['store', '--label=SuperSurf: banking', 'service', 'supersurf', 'name', 'banking', 'domain', 'example.com'],
        expect.objectContaining({ input: 'hunter2', stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });

    it('omits domain attribute when not provided', async () => {
      mockExec.mockReturnValueOnce(Buffer.from(''));
      const backend = new LinuxKeychainBackend();
      await backend.add('github', 'ghp_token');
      expect(mockExec).toHaveBeenCalledWith(
        'secret-tool',
        ['store', '--label=SuperSurf: github', 'service', 'supersurf', 'name', 'github'],
        expect.objectContaining({ input: 'ghp_token' }),
      );
    });
  });

  describe('get', () => {
    it('returns the password from secret-tool lookup', async () => {
      mockExec.mockReturnValueOnce(Buffer.from('hunter2\n'));
      const backend = new LinuxKeychainBackend();
      expect(await backend.get('banking')).toBe('hunter2');
      expect(mockExec).toHaveBeenCalledWith(
        'secret-tool',
        ['lookup', 'service', 'supersurf', 'name', 'banking'],
        expect.any(Object),
      );
    });

    it('returns null when secret-tool exits non-zero (not found)', async () => {
      mockExec.mockImplementationOnce(() => {
        const err: any = new Error('exit 1');
        err.status = 1;
        err.stderr = Buffer.from('');
        throw err;
      });
      const backend = new LinuxKeychainBackend();
      expect(await backend.get('nonexistent')).toBeNull();
    });
  });

  describe('list', () => {
    it('parses secret-tool search --all output into name+domain entries', async () => {
      const out = `[/org/freedesktop/secrets/collection/login/1]
label = SuperSurf: banking
secret = hunter2
created = 2026-05-27 12:00:00
modified = 2026-05-27 12:00:00
schema = org.freedesktop.Secret.Generic
attribute.service = supersurf
attribute.name = banking
attribute.domain = example.com

[/org/freedesktop/secrets/collection/login/2]
label = SuperSurf: github
secret = ghp_token
created = 2026-05-27 12:00:00
modified = 2026-05-27 12:00:00
schema = org.freedesktop.Secret.Generic
attribute.service = supersurf
attribute.name = github
`;
      mockExec.mockReturnValueOnce(Buffer.from(out));
      const backend = new LinuxKeychainBackend();
      const result = await backend.list();
      expect(result).toEqual([
        { name: 'banking', domain: 'example.com' },
        { name: 'github' },
      ]);
      expect(mockExec).toHaveBeenCalledWith(
        'secret-tool',
        ['search', '--all', '--unlock', 'service', 'supersurf'],
        expect.any(Object),
      );
    });

    it('returns empty array when secret-tool reports no results (exit 1, no items)', async () => {
      mockExec.mockImplementationOnce(() => {
        const err: any = new Error('exit 1');
        err.status = 1;
        err.stderr = Buffer.from('');
        throw err;
      });
      const backend = new LinuxKeychainBackend();
      expect(await backend.list()).toEqual([]);
    });
  });

  describe('remove', () => {
    it('invokes secret-tool clear with service+name attributes', async () => {
      mockExec.mockReturnValueOnce(Buffer.from(''));
      const backend = new LinuxKeychainBackend();
      await backend.remove('banking');
      expect(mockExec).toHaveBeenCalledWith(
        'secret-tool',
        ['clear', 'service', 'supersurf', 'name', 'banking'],
        expect.any(Object),
      );
    });

    it('throws KeychainError when name does not exist (secret-tool clear is silent on missing — we check first via get)', async () => {
      mockExec.mockImplementationOnce(() => {
        const err: any = new Error('exit 1');
        err.status = 1;
        err.stderr = Buffer.from('');
        throw err;
      });
      const backend = new LinuxKeychainBackend();
      await expect(backend.remove('nonexistent')).rejects.toThrow(/not found/i);
    });
  });
});
