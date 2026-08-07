import { describe, it, expect } from 'vitest';
import { isMajorJump } from '../../src/utils/version';

describe('isMajorJump', () => {
  it('returns true when the major version increased', () => {
    expect(isMajorJump('2.9.9', '3.0.0')).toBe(true);
    expect(isMajorJump('1.0.0', '2.0.0')).toBe(true);
  });

  it('returns false for a minor bump', () => {
    expect(isMajorJump('3.2.0', '3.3.0')).toBe(false);
  });

  it('returns false for a patch bump', () => {
    expect(isMajorJump('3.3.0', '3.3.1')).toBe(false);
  });

  it('returns false for a downgrade', () => {
    expect(isMajorJump('3.0.0', '2.5.0')).toBe(false);
  });

  it('returns false when prev is undefined', () => {
    expect(isMajorJump(undefined, '3.0.0')).toBe(false);
  });

  it('returns false when prev or curr is unparsable', () => {
    expect(isMajorJump('garbage', '3.0.0')).toBe(false);
    expect(isMajorJump('2.0.0', 'garbage')).toBe(false);
  });

  it('returns false for the same version', () => {
    expect(isMajorJump('3.3.0', '3.3.0')).toBe(false);
  });
});
