import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The SuperSurf skill ships in two places: `plugin/skills/supersurf/SKILL.md`
 * (the plugin, loaded by the harness) and `docs/skill.md` (the public URL that
 * `connect`'s description and README point agents at). The plugin copy is the
 * source of truth; the docs copy must stay byte-identical or one audience reads
 * stale guidance (see BACKLOG #62 for the last time a copy drifted).
 */
const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('plugin skill and published docs/skill.md', () => {
  it('are identical', () => {
    expect(read('docs/skill.md')).toBe(read('plugin/skills/supersurf/SKILL.md'));
  });
});
