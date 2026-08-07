/**
 * @module utils/version
 *
 * Semver-ish version comparison helpers for the extension. No dependency on
 * a real semver library — the extension ships zero runtime dependencies.
 */

/** Extract the major component of a semver-ish `x.y.z` string, or null if unparsable. */
function parseMajor(version: string | null | undefined): number | null {
  if (typeof version !== 'string') return null;
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

/**
 * True only when both versions parse as semver-ish `x.y.z` and the current
 * major is strictly greater than the previous major. Same-major minor/patch
 * bumps, downgrades, missing `prev`, and unparsable input are all false.
 */
export function isMajorJump(prev: string | undefined, curr: string): boolean {
  const prevMajor = parseMajor(prev);
  const currMajor = parseMajor(curr);
  if (prevMajor === null || currMajor === null) return false;
  return currMajor > prevMajor;
}
