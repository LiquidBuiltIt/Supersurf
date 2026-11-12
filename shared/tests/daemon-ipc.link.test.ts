import { describe, it, expect } from 'vitest';
import { versionMismatch, isVersionMismatch } from '../index';

describe('version mismatch error', () => {
  it('carries code, both versions and the reason', () => {
    const e = versionMismatch('4.0.0', '4.1.0', 'Because.');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('version_mismatch');
    expect(e.daemonVersion).toBe('4.0.0');
    expect(e.serverVersion).toBe('4.1.0');
    expect(e.reason).toBe('Because.');
  });

  it('a pre-3.0 daemon is a null daemonVersion', () => {
    const e = versionMismatch(null, '4.1.0', 'r');
    expect(e.daemonVersion).toBeNull();
    expect(e.message).toContain('pre-3.0');
  });

  it('isVersionMismatch is duck-typed, so it works across two copies of shared', () => {
    const foreign = Object.assign(new Error('x'), { code: 'version_mismatch' });
    expect(isVersionMismatch(foreign)).toBe(true);
    expect(isVersionMismatch(new Error('x'))).toBe(false);
    expect(isVersionMismatch(null)).toBe(false);
    expect(isVersionMismatch('version_mismatch')).toBe(false);
  });
});
