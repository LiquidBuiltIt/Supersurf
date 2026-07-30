import { describe, it, expect } from 'vitest';
import {
  applyKeepBrowserPreference,
  shouldKeepBrowserOnSessionEnd,
} from '../../src/profiles/keep-browser';

describe('shouldKeepBrowserOnSessionEnd', () => {
  it('returns true when conn is null/undefined', () => {
    expect(shouldKeepBrowserOnSessionEnd(null)).toBe(true);
    expect(shouldKeepBrowserOnSessionEnd(undefined)).toBe(true);
  });

  it('returns true when field is missing', () => {
    expect(shouldKeepBrowserOnSessionEnd({})).toBe(true);
  });

  it('returns true when field is true', () => {
    expect(shouldKeepBrowserOnSessionEnd({ keepBrowserOnSessionEnd: true })).toBe(true);
  });

  it('returns false only when field is explicitly false', () => {
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
