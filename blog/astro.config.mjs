// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

// The blog is emitted into the tracked Pages root, so `outDir` MUST stay
// scoped to `docs/blog` and never to `docs/` itself — Astro empties its
// outDir on every build, and `docs/` holds hand-written pages, the install
// script and the demo videos.
export default defineConfig({
  site: 'https://liquidbuiltit.github.io',
  base: '/Supersurf/blog',
  outDir: '../docs/blog',
  trailingSlash: 'always',
  integrations: [mdx()],
  build: { format: 'directory' },
});
