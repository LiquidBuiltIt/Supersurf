import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

// Feeds the homepage teaser card in `docs/index.html` (see the drift-lock
// test — that page must carry no hand-written version string, so the latest
// post's title/date/url come from here at request time instead).
export const GET: APIRoute = async () => {
  const base = import.meta.env.BASE_URL;
  const posts = (await getCollection('blog', ({ data }) => !data.draft))
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
    .map((post) => ({
      title: post.data.title,
      date: post.data.date.toISOString().slice(0, 10),
      version: post.data.version,
      summary: post.data.summary,
      url: `${base}/${post.id}/`.replace(/\/+/g, '/'),
    }));

  return new Response(JSON.stringify(posts), {
    headers: { 'Content-Type': 'application/json' },
  });
};
