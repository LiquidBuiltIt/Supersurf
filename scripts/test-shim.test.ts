import { describe, it, expect, vi } from 'vitest';
import { findGo } from './find-go';
import { runTestShim } from './test-shim';

describe('findGo', () => {
  it('returns null when no candidate runs', () => {
    expect(findGo(['/nonexistent/go', undefined])).toBeNull();
  });

  it('returns the first candidate that answers `version`', () => {
    expect(findGo(['/nonexistent/go', '/bin/true', 'node'])).toBe('/bin/true');
  });
});

describe('runTestShim', () => {
  it('prints the skip line and returns 0 when there is no go toolchain', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runTestShim(null)).toBe(0);
    expect(log).toHaveBeenCalledWith('test.shim skipped: no go toolchain');
    log.mockRestore();
  });
});
