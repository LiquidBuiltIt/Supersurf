// server/tests/fingerprinting-naming.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeName, wasNormalized } from '../src/experimental/fingerprinting/naming';

describe('normalizeName', () => {
  it('lowercases and snake-cases spaces and camelCase boundaries are left as-is (only separators collapse)', () => {
    expect(normalizeName('First Name Input')).toBe('first_name_input');
    expect(normalizeName('first-name-input')).toBe('first_name_input');
    expect(normalizeName('  Submit  ')).toBe('submit');
  });
  it('collapses runs of non-alphanumerics to a single underscore and trims edge underscores', () => {
    expect(normalizeName('foo   bar')).toBe('foo_bar');
    expect(normalizeName('__weird--name__')).toBe('weird_name');
    expect(normalizeName('a.b/c:d')).toBe('a_b_c_d');
  });
  it('preserves already-canonical names', () => {
    expect(normalizeName('first_name')).toBe('first_name');
  });
  it('returns empty string for nullish/empty input', () => {
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName(null)).toBe('');
    expect(normalizeName('   ')).toBe('');
    expect(normalizeName('!!!')).toBe('');
  });
  it('caps length at 64 chars', () => {
    expect(normalizeName('x'.repeat(100)).length).toBe(64);
  });
  it('never leaves a trailing underscore after the 64-char cap', () => {
    const out = normalizeName('a'.repeat(63) + ' bbbb');
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.endsWith('_')).toBe(false);
  });
});

describe('wasNormalized', () => {
  it('is false when the trimmed input already equals its normalized form', () => {
    expect(wasNormalized('first_name')).toBe(false);
  });
  it('is true when normalization changed the input', () => {
    expect(wasNormalized('First Name')).toBe(true);
    expect(wasNormalized('first-name')).toBe(true);
  });
  it('is false for nullish/empty', () => {
    expect(wasNormalized(undefined)).toBe(false);
    expect(wasNormalized('')).toBe(false);
  });
});
