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

/**
 * BACKLOG #49. `README.md` states the tool count by hand in more than one
 * place — the `## Tools` badge and the Features table both drifted to 28 while
 * the tool tables listed 30. Deriving either would need README.md to consume
 * `tools/schemas.ts` at build time, which is a bigger change than this bug
 * warrants — so this test asserts *every* written count agrees with the rows,
 * not just the badge. Scoping it to the badge alone is how the second copy
 * survived the first fix.
 */
describe('README.md tool counts match its own tool tables', () => {
  const readme = readFileSync(resolve(__dirname, '..', 'README.md'), 'utf8');

  it('every hand-written count equals the number of tool rows', () => {
    const toolsSection = readme.split(/^## Tools$/m)[1]?.split(/^## /m)[0] ?? '';
    const toolRows = toolsSection.match(/^\| `[a-zA-Z_]+` \|/gm) ?? [];
    expect(toolRows.length).toBeGreaterThan(0);

    // Matches both the shields.io badge (`30-browser%20tools`) and prose
    // (`30 browser tools`).
    const written = [...readme.matchAll(/(\d+)[-\s]browser(?:%20|\s)tools/g)].map((m) => ({
      count: Number(m[1]),
      text: m[0],
    }));
    expect(written.length).toBeGreaterThan(1);

    expect(written.filter((w) => w.count !== toolRows.length)).toEqual([]);
  });
});
