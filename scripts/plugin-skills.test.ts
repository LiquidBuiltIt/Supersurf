// scripts/plugin-skills.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';

/**
 * Every plugin skill must (a) carry frontmatter whose `name` matches its
 * directory, and (b) only name MCP tools that actually exist. A renamed tool
 * otherwise leaves every skill quietly teaching a call that errors.
 */
const root = resolve(__dirname, '..');
const skillsDir = join(root, 'plugin/skills');
const SKILLS = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const TOOL_NAMES = new Set(
  [...walk(join(root, 'server/src/tools')), ...walk(join(root, 'server/src/backend'))]
    .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/name: ['"]([a-z_]+)['"]/g)].map((m) => m[1])),
);
const TOOL_REF = /\b(browser_[a-z_]+|secure_fill|profile_(?:create|delete|list))\b/g;

describe.each(SKILLS)('plugin skill %s', (name) => {
  const text = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');

  it('has frontmatter with a matching name and a description', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    expect(fm).toMatch(new RegExp(`^name: ${name}$`, 'm'));
    expect(fm).toMatch(/^description: .{20,}$/m);
  });

  it('names only tools that exist', () => {
    const unknown = [...new Set([...text.matchAll(TOOL_REF)].map((m) => m[1]))].filter((t) => !TOOL_NAMES.has(t));
    expect(unknown).toEqual([]);
  });
});

describe('base skill', () => {
  const base = readFileSync(join(skillsDir, 'supersurf/SKILL.md'), 'utf8');
  it('has the 9 hard rules, a glossary, and links every sibling skill', () => {
    expect(base).toMatch(/^## Hard Rules$/m);
    expect((base.match(/^\d\. /gm) ?? []).length).toBeGreaterThanOrEqual(9);
    expect(base).toMatch(/^## Glossary$/m);
    for (const s of SKILLS.filter((s) => s !== 'supersurf')) {
      expect(base).toContain(`plugin/skills/${s}/SKILL.md`);
    }
  });
});
