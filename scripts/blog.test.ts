import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { scaffoldPost } from './blog.scaffold';

// Mirrors `generateId` in `blog/src/content.config.ts`. Astro's default would
// run the filename through `github-slugger` and strip the dots ("4.0.0.mdx" ->
// "/400/"), so the loader overrides it. Duplicated rather than imported: the
// only copy lives in an `astro:content` module this test cannot load, and
// `blog/node_modules` is gitignored, so importing from there fails on a fresh
// clone.
const postSlug = (file: string) => file.replace(/\.mdx$/, '').replace(/\./g, '-');

const TMP_ROOT = join(process.env.TMPDIR || '/tmp/claude-1000', 'blog-scaffold-test');
mkdirSync(TMP_ROOT, { recursive: true });
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

const CHANGELOG_SAMPLE = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '## 1.2.0 — 2026-01-05',
  '',
  '*A minor release with a short story.*',
  '',
  '- feat: **added a thing.** Does a thing now.',
  '- fix: fixed a bug.',
  '',
].join('\n');

describe('scaffoldPost', () => {
  it('skips a patch bump', () => {
    const outDir = join(TMP_ROOT, 'patch');
    const result = scaffoldPost('1.2.1', {
      date: '2026-01-05',
      changelogText: CHANGELOG_SAMPLE,
      outDir,
      bumpType: 'patch',
    });
    expect(result.written).toBe(false);
    expect(existsSync(result.path)).toBe(false);
  });

  it('skips an existing file without overwriting it', () => {
    const outDir = join(TMP_ROOT, 'existing');
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, '1.2.0.mdx');
    writeFileSync(path, 'hand-authored content');

    const result = scaffoldPost('1.2.0', {
      date: '2026-01-05',
      changelogText: CHANGELOG_SAMPLE,
      outDir,
      bumpType: 'minor',
    });

    expect(result.written).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('hand-authored content');
  });

  it('writes frontmatter that satisfies the content.config schema fields', () => {
    const outDir = join(TMP_ROOT, 'valid');
    const result = scaffoldPost('1.2.0', {
      date: '2026-01-05',
      changelogText: CHANGELOG_SAMPLE,
      outDir,
      bumpType: 'minor',
    });

    expect(result.written).toBe(true);
    const text = readFileSync(result.path, 'utf8');
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    expect(match).not.toBeNull();
    const [, frontmatter, body] = match!;

    const field = (name: string) => frontmatter.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1];

    // title: z.string()
    expect(field('title')).toMatch(/^".+"$/);
    // date: z.coerce.date() — must parse
    expect(Number.isNaN(Date.parse(field('date')!))).toBe(false);
    // version: z.string().regex(/^\d+\.\d+\.\d+$/)
    expect(field('version')?.replace(/"/g, '')).toMatch(/^\d+\.\d+\.\d+$/);
    // summary: z.string()
    expect(field('summary')).toMatch(/^".+"$/);
    // draft: z.boolean().default(true) — scaffold always emits true
    expect(field('draft')).toBe('true');

    expect(body).toContain('## What changed');
    expect(body).toContain('added a thing');
    expect(body).toContain('TODO');
  });
});

/**
 * Same spirit as `docs-version-drift.test.ts`: catches "forgot to rebuild
 * the blog" before it ships. Every non-draft post in the source tree must
 * have a corresponding emitted page under `docs/blog/`.
 */
describe('blog build drift lock', () => {
  const contentDir = resolve(__dirname, '..', 'blog', 'src', 'content', 'blog');
  const docsBlogDir = resolve(__dirname, '..', 'docs', 'blog');

  const mdxFiles = existsSync(contentDir) ? readdirSync(contentDir).filter((f) => f.endsWith('.mdx')) : [];

  it('every non-draft post has an emitted docs/blog/<slug>/index.html', () => {
    const missing: string[] = [];
    for (const file of mdxFiles) {
      const text = readFileSync(join(contentDir, file), 'utf8');
      const isDraft = /^draft:\s*true\s*$/m.test(text);
      if (isDraft) continue; // drafts are never emitted — nothing to check
      const slug = postSlug(file);
      const emitted = join(docsBlogDir, slug, 'index.html');
      if (!existsSync(emitted)) missing.push(`${file} -> ${emitted}`);
    }
    expect(missing).toEqual([]);
  });
});
