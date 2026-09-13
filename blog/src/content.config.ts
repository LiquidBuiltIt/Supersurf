import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({
    base: './src/content/blog',
    pattern: '**/*.mdx',
    // Astro's default id derivation runs the filename through `github-slugger`,
    // which strips dots — "4.0.0.mdx" would publish at /blog/400/. Dashes are
    // both readable and stable, so derive the id here instead.
    generateId: ({ entry }) => entry.replace(/\.mdx$/, '').replace(/\./g, '-'),
  }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be X.Y.Z'),
    summary: z.string(),
    // A scaffolded post starts as a draft. Drafts build in `astro dev` and are
    // dropped from the emitted site, so an unfinished post can never ship by
    // accident.
    draft: z.boolean().default(true),
  }),
});

export const collections = { blog };
