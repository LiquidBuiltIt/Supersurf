import { describe, it, expect } from 'vitest';
import { isProfileMethod } from '../../src/profiles/types';

describe('isProfileMethod', () => {
  it('returns true for profile methods', () => {
    expect(isProfileMethod('profiles.create')).toBe(true);
    expect(isProfileMethod('profiles.list')).toBe(true);
    expect(isProfileMethod('profiles.delete')).toBe(true);
    expect(isProfileMethod('profiles.connect')).toBe(true);
  });

  it('returns false for non-profile methods', () => {
    expect(isProfileMethod('navigate')).toBe(false);
    expect(isProfileMethod('experiments.toggle')).toBe(false);
    expect(isProfileMethod('profiles.unknown')).toBe(false);
    expect(isProfileMethod('')).toBe(false);
  });
});
