/**
 * Pure release-blog scaffolding, called from `version.bump.ts` right after
 * the changelog cut. A patch never gets a post (see `## Post trigger` in
 * the blog build notes) and an existing `.mdx` is an author's work in
 * progress — both cases skip silently, never throw, so a broken scaffold
 * can never fail a version bump.
 *
 * Bullets are inlined into the MDX body as literal Markdown at scaffold
 * time rather than read from CHANGELOG.md at build time: a dated post is a
 * snapshot, and MDX already renders Markdown, so there is no renderer here
 * to own.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseSections, extractBullets, extractSummary, headerDate } from './changelog-json';

export type BumpType = 'patch' | 'minor' | 'major';

export interface ScaffoldOpts {
  date: string; // fallback YYYY-MM-DD if the changelog section carries none
  changelogText: string; // full CHANGELOG.md content, post-cut, containing "## <version> — <date>"
  outDir: string; // directory to write "<version>.mdx" into, e.g. blog/src/content/blog
  bumpType: BumpType;
}

export interface ScaffoldResult {
  path: string;
  written: boolean;
}

function escapeYamlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function scaffoldPost(version: string, opts: ScaffoldOpts): ScaffoldResult {
  const path = join(opts.outDir, `${version}.mdx`);

  // Patches never get a post.
  if (opts.bumpType === 'patch') {
    return { path, written: false };
  }

  // Never overwrite an author's work.
  if (existsSync(path)) {
    return { path, written: false };
  }

  const sections = parseSections(opts.changelogText);
  const section = sections.find((s) => s.kind === 'version' && s.version === version);
  const bullets = section ? extractBullets(section.raw) : [];
  const summary = (section && extractSummary(section.raw)) || `What's new in v${version}.`;
  const date = (section && headerDate(section.raw)) || opts.date;

  const bulletsMd =
    bullets.length > 0
      ? bullets.map((b) => `- ${b}`).join('\n')
      : '- TODO: no changelog bullets found for this version — fill in by hand.';

  const body = `---
title: "v${version}"
date: ${date}
version: "${version}"
summary: "${escapeYamlString(summary)}"
draft: true
---

**TODO:** write the intro prose for this release, then flip \`draft\` to \`false\`.

## What changed

${bulletsMd}
`;

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(path, body);
  return { path, written: true };
}
