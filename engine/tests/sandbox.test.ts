import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { sandboxPath } from '../src/tools/lib/sandbox';

describe('sandboxPath', () => {
  const home = os.homedir();

  it('returns absolute paths inside $HOME as-is (normalized)', () => {
    const input = path.join(home, 'x.png');
    expect(sandboxPath(input)).toBe(path.resolve(input));
  });

  it('does not double-prefix an absolute path already under $HOME', () => {
    const input = path.join(home, 'shots', 'a.png');
    const result = sandboxPath(input);
    expect(result).toBe(path.resolve(input));
    expect(result).not.toContain(home + home);
  });

  it('resolves an absolute path exactly equal to $HOME', () => {
    expect(sandboxPath(home)).toBe(home);
  });

  it('throws a clear error for an absolute path outside $HOME', () => {
    expect(() => sandboxPath('/tmp/shot.png')).toThrow(
      'Path must be inside your home directory. Use a relative path (resolved from $HOME) or an absolute path under $HOME.'
    );
  });

  it('does not echo the resolved/rewritten path in the out-of-jail error', () => {
    try {
      sandboxPath('/etc/passwd');
      expect.unreachable('sandboxPath should have thrown');
    } catch (err: any) {
      expect(err.message).not.toContain('/etc/passwd');
      expect(err.message).not.toContain(home);
    }
  });

  it('resolves relative paths against $HOME unchanged from today', () => {
    expect(sandboxPath('Desktop/file.png')).toBe(path.resolve(home, 'Desktop/file.png'));
  });

  it('throws the same clear error for `..` traversal escaping $HOME', () => {
    expect(() => sandboxPath('../../etc/passwd')).toThrow(
      'Path must be inside your home directory. Use a relative path (resolved from $HOME) or an absolute path under $HOME.'
    );
  });

  it('allows `..` traversal that stays within $HOME (symlink-free normalization)', () => {
    const result = sandboxPath(path.join(home, 'a', '..', 'b'));
    expect(result).toBe(path.resolve(home, 'b'));
  });
});
