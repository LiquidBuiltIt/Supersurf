import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * BACKLOG #38. The binary reaches a user through three files that never import
 * each other, so nothing but this test notices when one of them drifts:
 *
 *   cli/build.ts        compiles `build/supersurf-<os>-<arch>`
 *   scripts/publish.ts  uploads those filenames as release assets
 *   docs/install.sh     downloads `supersurf-<os>-<arch>` built from `uname`
 *
 * A rename on any one side produces a release that looks complete and an
 * install command that 404s — and it 404s for users, on a published URL,
 * after the release is already out. Hence a lock rather than care.
 */
const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

describe('release asset names are the same on all three sides', () => {
  it('cli/build.ts compiles exactly the four expected targets', () => {
    const build = read('cli/build.ts');
    for (const t of TARGETS) expect(build).toContain(`'bun-${t}'`);
    // The output name is what everything else keys off.
    expect(build).toContain('`./build/supersurf-${suffix}`');
  });

  it('publish.ts uploads the same four names', () => {
    const publish = read('scripts/publish.ts');
    const list = publish.match(/const BINARY_TARGETS = \[([^\]]*)\]/);
    expect(list, 'BINARY_TARGETS not found in publish.ts').toBeTruthy();
    const found = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(found.sort()).toEqual([...TARGETS].sort());
    expect(publish).toContain('`supersurf-${target}`');
  });

  it('install.sh builds the same filename shape', () => {
    expect(read('docs/install.sh')).toContain("'supersurf-%s-%s'");
  });
});

/**
 * The npx pin makes a version number load-bearing: a binary compiled at an
 * already-published version shells out to the package that release exists to
 * replace. The refusal must live in the release path, never in cli/build.ts —
 * between releases the repo version IS the published version, so a build-time
 * check would refuse (or warn on) every routine dev compile.
 */
describe('the release path refuses an already-published version', () => {
  const publish = read('scripts/publish.ts');

  it('preflight asks npm whether this version exists', () => {
    expect(publish).toMatch(/npm view supersurf-mcp@\$\{version\}/);
  });

  it('only a genuine 404 clears the gate — it must not fail open', () => {
    // A registry outage exits non-zero too. Reading any non-zero exit as
    // "not published" would disable the guard exactly when npm is unreachable.
    expect(publish).toMatch(/E404\|No match found for version/);
  });

  it('cli/build.ts carries no such check', () => {
    const build = read('cli/build.ts');
    expect(build).not.toContain('npm view');
  });
});
