import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * BACKLOG #40. `docs/index.html` is the public landing page, and it carried two
 * hand-written version strings that nothing kept current: a `<span>v…</span>`
 * chip that read `v1.4.3` while the repo was at `3.4.0`, and a JSON-LD
 * `"softwareVersion"` that had drifted separately to `3.1.0`. Both were
 * corrected by hand once, which fixes a day and guarantees the same drift by
 * the next release.
 *
 * `scripts/version.bump.ts` rewrites the `version` field of seven JSON files
 * and has no mechanism for HTML, so the fix was to delete the strings rather
 * than add a second rewriting mechanism to maintain them. This test is what
 * makes that decision stick: it fails the moment a version is written back in.
 *
 * If a version on the landing page is ever genuinely wanted, the fix is to
 * teach `version.bump` to own it — and to delete this test in the same commit.
 */
const html = readFileSync(resolve(__dirname, '..', 'docs', 'index.html'), 'utf8');

describe('docs/index.html carries no hand-maintained version string', () => {
  // Dotted quads are stripped first: the page names 127.0.0.1 when it explains
  // that the WebSocket is loopback-bound, and that is not a version.
  const withoutIps = html.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '');

  it('contains no semver-shaped literal', () => {
    const found = withoutIps.match(/\bv?\d+\.\d+\.\d+\b/g) ?? [];
    expect(found).toEqual([]);
  });

  it('declares no JSON-LD softwareVersion', () => {
    expect(html).not.toContain('softwareVersion');
  });

  it('still states the licence the LICENSE file actually grants', () => {
    // The JSON-LD used to point at the plain Apache-2.0 text while the project
    // ships Apache-2.0 *with a Commons Clause*. A licence misstatement in
    // structured data is one search engines consume and repeat.
    expect(html).not.toContain('apache.org/licenses/LICENSE-2.0');
    expect(html).toContain('Commons Clause');
  });
});
