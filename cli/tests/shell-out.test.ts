import { describe, it, expect } from 'vitest';
import { npxTarget } from '../src/shell-out';
import { VERSION } from '../src/version';

describe('npxTarget', () => {
  it('pins the mcp package to the binary\'s own version', () => {
    expect(npxTarget('supersurf-mcp')).toBe(`supersurf-mcp@${VERSION}`);
  });

  it('pins the daemon package to the binary\'s own version', () => {
    expect(npxTarget('supersurf-daemon')).toBe(`supersurf-daemon@${VERSION}`);
  });

  it('never emits @latest', () => {
    expect(npxTarget('supersurf-mcp')).not.toContain('@latest');
    expect(npxTarget('supersurf-daemon')).not.toContain('@latest');
  });
});
