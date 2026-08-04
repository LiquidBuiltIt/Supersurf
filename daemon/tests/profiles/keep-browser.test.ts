import { describe, it, expect } from 'vitest';
import {
  applyKeepBrowserPreference,
  shouldKeepBrowserOnSessionEnd,
} from '../../src/profiles/keep-browser';

describe('shouldKeepBrowserOnSessionEnd', () => {
  it('returns false when conn is null/undefined (no preference → fail closed, kill)', () => {
    expect(shouldKeepBrowserOnSessionEnd(null)).toBe(false);
    expect(shouldKeepBrowserOnSessionEnd(undefined)).toBe(false);
  });

  it('returns false when field is missing on a pooled connection (opt-in default)', () => {
    expect(shouldKeepBrowserOnSessionEnd({})).toBe(false);
  });

  it('returns true only when field is explicitly true', () => {
    expect(shouldKeepBrowserOnSessionEnd({ keepBrowserOnSessionEnd: true })).toBe(true);
  });

  it('returns false when field is false', () => {
    expect(shouldKeepBrowserOnSessionEnd({ keepBrowserOnSessionEnd: false })).toBe(false);
  });
});

describe('applyKeepBrowserPreference', () => {
  it('applyKeepBrowserPreference sets boolean values', () => {
    const conn = { keepBrowserOnSessionEnd: true };
    applyKeepBrowserPreference(conn, false);
    expect(conn.keepBrowserOnSessionEnd).toBe(false);
    applyKeepBrowserPreference(conn, true);
    expect(conn.keepBrowserOnSessionEnd).toBe(true);
  });

  it('applyKeepBrowserPreference ignores non-boolean', () => {
    const conn = { keepBrowserOnSessionEnd: false };
    applyKeepBrowserPreference(conn, 'yes');
    expect(conn.keepBrowserOnSessionEnd).toBe(false);
  });
});
