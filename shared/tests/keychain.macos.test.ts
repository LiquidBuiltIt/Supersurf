import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { MacosKeychainBackend } from '../keychain/macos';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExec = vi.mocked(execFileSync);

describe('MacosKeychainBackend', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  describe('add', () => {
    it('invokes security add-generic-password with correct args including -U for overwrite', async () => {
      mockExec.mockReturnValueOnce(Buffer.from(''));
      const backend = new MacosKeychainBackend();
      await backend.add('banking', 'hunter2', 'example.com');
      expect(mockExec).toHaveBeenCalledWith(
        'security',
        ['add-generic-password', '-U', '-s', 'supersurf', '-a', 'banking', '-j', 'example.com', '-w', 'hunter2'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      );
    });

    it('omits -j flag when domain is not provided', async () => {
      mockExec.mockReturnValueOnce(Buffer.from(''));
      const backend = new MacosKeychainBackend();
      await backend.add('github', 'ghp_token');
      expect(mockExec).toHaveBeenCalledWith(
        'security',
        ['add-generic-password', '-U', '-s', 'supersurf', '-a', 'github', '-w', 'ghp_token'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      );
    });
  });

  describe('get', () => {
    it('returns the password from find-generic-password -w', async () => {
      mockExec.mockReturnValueOnce(Buffer.from('hunter2\n'));
      const backend = new MacosKeychainBackend();
      const result = await backend.get('banking');
      expect(result).toBe('hunter2');
      expect(mockExec).toHaveBeenCalledWith(
        'security',
        ['find-generic-password', '-s', 'supersurf', '-a', 'banking', '-w'],
        expect.any(Object),
      );
    });

    it('returns null when security exits with non-zero (item not found)', async () => {
      mockExec.mockImplementationOnce(() => {
        const err: any = new Error('exit 44');
        err.status = 44;
        err.stderr = Buffer.from('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
        throw err;
      });
      const backend = new MacosKeychainBackend();
      expect(await backend.get('nonexistent')).toBeNull();
    });
  });

  describe('list', () => {
    it('parses dump-keychain output into name + domain entries', async () => {
      const dump = `
keychain: "/Users/test/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    0x00000007 <blob>="banking"
    "acct"<blob>="banking"
    "cmnt"<blob>="example.com"
    "svce"<blob>="supersurf"
keychain: "/Users/test/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    0x00000007 <blob>="github"
    "acct"<blob>="github"
    "cmnt"<blob>=<NULL>
    "svce"<blob>="supersurf"
keychain: "/Users/test/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="someotherapp"
    "svce"<blob>="not-supersurf"
`;
      mockExec.mockReturnValueOnce(Buffer.from(dump));
      const backend = new MacosKeychainBackend();
      const result = await backend.list();
      expect(result).toEqual([
        { name: 'banking', domain: 'example.com' },
        { name: 'github' },
      ]);
      expect(mockExec).toHaveBeenCalledWith(
        'security',
        ['dump-keychain'],
        expect.any(Object),
      );
    });

    it('returns empty array when no supersurf entries exist', async () => {
      mockExec.mockReturnValueOnce(Buffer.from('keychain: "/path"\nclass: "genp"\nattributes:\n    "svce"<blob>="other"\n'));
      const backend = new MacosKeychainBackend();
      expect(await backend.list()).toEqual([]);
    });
  });

  describe('remove', () => {
    it('invokes security delete-generic-password with -s and -a', async () => {
      mockExec.mockReturnValueOnce(Buffer.from(''));
      const backend = new MacosKeychainBackend();
      await backend.remove('banking');
      expect(mockExec).toHaveBeenCalledWith(
        'security',
        ['delete-generic-password', '-s', 'supersurf', '-a', 'banking'],
        expect.any(Object),
      );
    });

    it('throws KeychainError when item does not exist', async () => {
      mockExec.mockImplementationOnce(() => {
        const err: any = new Error('exit 44');
        err.status = 44;
        err.stderr = Buffer.from('The specified item could not be found in the keychain.');
        throw err;
      });
      const backend = new MacosKeychainBackend();
      await expect(backend.remove('nonexistent')).rejects.toThrow(/not found/i);
    });
  });
});
