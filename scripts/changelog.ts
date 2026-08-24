#!/usr/bin/env npx tsx
/**
 * Print a single CHANGELOG.md section by version.
 *
 * Usage:
 *   npm run changelog                 # newest released version (same as `latest`)
 *   npm run changelog -- latest       # newest released version section
 *   npm run changelog -- unreleased   # the ## Unreleased section
 *   npm run changelog -- 3.2.0        # that exact version's section
 *   npm run changelog -- 3.2          # partial ok -> resolves to 3.2.0
 *   npm run changelog -- 3.3.7        # no match -> auto-corrects to the closest version
 *   npm run changelog -- 3.2.0 -v     # --verbose: full entry text
 *   npm run changelog -- ls           # list available versions (with dates)
 *   npm run changelog -- json         # emit every section as JSON (stdout)
 *   npm run changelog -- json --out <path>   # emit JSON to a file instead
 *   npm run changelog -- --help       # usage
 *
 * By default each change is reduced to its one-line statement (the leading
 * **bold** summary, else the first sentence). `-v`/`--verbose` prints the full
 * entry text. The flag may appear before or after the version argument.
 *
 * "latest" is the newest *released* version (top-most `## X.Y.Z`); the in-flight
 * `## Unreleased` block is reached only via the explicit `unreleased` keyword.
 *
 * The chosen section prints to stdout; the auto-correct notice (if any) prints
 * to stderr, so `npm run changelog -- 3.3 > out.md` captures a clean section.
 *
 * `json` emits every parsed section (Unreleased included, newest-first — the
 * same order `parseSections` returns) as `{ sections: [{ version, date,
 * bullets }] }`. `version` is `"Unreleased"` for the in-flight section (its
 * `date` is `null`), else the `X.Y.Z` string. `bullets` are the raw top-level
 * bullet text (Markdown intact — `**bold**`/`` `code` `` left for the
 * consumer to render), unlike the compact one-line summaries used elsewhere
 * in this file.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import {
  parseSections,
  headerDate,
  sectionsToJson,
  extractBullets,
  typeBreakdown,
  type Section,
  type Parts,
} from './changelog-json';

// ANSI codes (matches the other scripts/ tooling)
const yellow = '\x1b[33m';
const cyan = '\x1b[36m';
const green = '\x1b[32m';
const red = '\x1b[31m';
const bold = '\x1b[1m';
const dim = '\x1b[2m';
const italic = '\x1b[3m';
const reset = '\x1b[0m';

const CHANGELOG = resolve(__dirname, '..', 'CHANGELOG.md');

/** Parse a query like "3", "3.2", "v3.2.1" into padded [major, minor, patch]. */
function parseQuery(q: string): Parts | null {
  const m = q.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** Weighted tuple distance; major dominates minor dominates patch. */
function distance(a: Parts, b: Parts): number {
  return (
    Math.abs(a[0] - b[0]) * 1_000_000 +
    Math.abs(a[1] - b[1]) * 1_000 +
    Math.abs(a[2] - b[2])
  );
}

function usage(versions: Section[]): string {
  return [
    'Usage: npm run changelog -- <latest|unreleased|x.x.x|ls|json> [-v|--verbose] [--out <path>]',
    '',
    '  latest         newest released version (default when no argument)',
    '  unreleased     the ## Unreleased section',
    '  x.x.x          a specific version; auto-corrects to the closest if not found',
    '  ls, list       list available versions (with dates)',
    '  json           emit every section as JSON ({ sections: [...] }); stdout, or --out <path>',
    '  -v, --verbose  full entry text (default: one-line change statements only)',
    '',
    `Run 'npm run changelog -- ls' to list all ${versions.length} versions.`,
  ].join('\n');
}

// ---- Pretty terminal rendering (TTY only) -------------------------------
// Renders a Markdown section to ANSI: colored version header + rule, bulleted
// list, and inline **bold** / `code` / *italic*, word-wrapped to the terminal.
// Only used when stdout is a TTY; piped/redirected output stays raw Markdown
// (see main), so `npm run changelog -- 3.2 > out.md` captures a clean section.

type Style = 'plain' | 'bold' | 'code' | 'italic';
interface Token {
  w: string;
  s: Style;
  glue: boolean; // true = attach to previous word with no space (e.g. `code`)
}

/** Split one line of inline Markdown into style-tagged words. */
function tokenize(text: string): Token[] {
  const segs: { t: string; s: Style }[] = [];
  let plain = '';
  let i = 0;
  const flushPlain = () => {
    if (plain) segs.push({ t: plain, s: 'plain' });
    plain = '';
  };
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flushPlain();
        segs.push({ t: text.slice(i + 1, end), s: 'code' });
        i = end + 1;
        continue;
      }
    } else if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        flushPlain();
        segs.push({ t: text.slice(i + 2, end), s: 'bold' });
        i = end + 2;
        continue;
      }
    } else if (text[i] === '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1) {
        flushPlain();
        segs.push({ t: text.slice(i + 1, end), s: 'italic' });
        i = end + 1;
        continue;
      }
    }
    plain += text[i];
    i += 1;
  }
  flushPlain();

  // Flatten to words; each word carries its segment's style so wrapping can
  // break anywhere without splitting an ANSI span across a line boundary.
  // `glue` records where the source had no space (e.g. `(`code`)` → `(code)`)
  // so punctuation stays attached to styled spans instead of drifting apart.
  const tokens: Token[] = [];
  let glue = false;
  for (const seg of segs) {
    for (const part of seg.t.split(/(\s+)/)) {
      if (part === '') continue;
      if (/^\s+$/.test(part)) {
        glue = false;
        continue;
      }
      tokens.push({ w: part, s: seg.s, glue });
      glue = true;
    }
  }
  return tokens;
}

function paint(w: string, s: Style): string {
  if (s === 'bold') return `${bold}${w}${reset}`;
  if (s === 'code') return `${green}${w}${reset}`;
  if (s === 'italic') return `${italic}${w}${reset}`;
  return w;
}

/** Greedy word-wrap. Visible width is measured on the raw words (paint() adds
 *  only zero-width ANSI), so the math stays honest. Spaces are baked into each
 *  token so a glued token attaches with none; breaks only ever fall on a real
 *  space boundary, never before a glued token. */
function wrapTokens(tokens: Token[], width: number, firstIndent: number, contIndent: number): string[] {
  const lines: string[] = [];
  let cur: string[] = [];
  let vis = 0;
  let indent = firstIndent;
  const flush = () => {
    lines.push(' '.repeat(indent) + cur.join(''));
    cur = [];
    vis = 0;
    indent = contIndent;
  };
  for (const { w, s, glue } of tokens) {
    const space = cur.length && !glue ? ' ' : '';
    if (space && indent + vis + space.length + w.length > width) flush();
    const sep = cur.length && !glue ? ' ' : ''; // recompute: flush() may have emptied cur
    vis += sep.length + w.length;
    cur.push(sep + paint(w, s));
  }
  if (cur.length) flush();
  return lines.length ? lines : [''];
}

function renderMarkdown(raw: string): string {
  const width = Math.min(process.stdout.columns || 80, 100);
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    if (/^##\s+/.test(line)) {
      const title = line.replace(/^##\s+/, '').trim();
      out.push('');
      out.push(`${bold}${cyan}${title}${reset}`);
      out.push(`${dim}${'─'.repeat(Math.min(width, Math.max(24, title.length)))}${reset}`);
      out.push('');
      continue;
    }
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      const lead = bullet[1].length;
      const wrapped = wrapTokens(tokenize(bullet[2]), width, lead + 2, lead + 2);
      // Swap the first line's indent for the bullet glyph (same 2-col width,
      // so continuation lines stay aligned under the text).
      wrapped[0] = `${' '.repeat(lead)}${cyan}•${reset} ${wrapped[0].slice(lead + 2)}`;
      // Space top-level entries apart so each change reads as its own block
      // (blank-collapse below keeps it to a single blank line).
      if (lead === 0) out.push('');
      out.push(...wrapped);
      continue;
    }
    const lead = line.length - line.trimStart().length;
    out.push(...wrapTokens(tokenize(line.trim()), width, lead, lead));
  }
  // Collapse runs of blank lines and trim the edges.
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** Item-count label for a version/section: plain `(N items)`, or — under
 *  `--verbose` — the per-type breakdown (`(2 feat, 1 fix, 1 chore)`), sorted
 *  by `typeBreakdown` (count desc, ties alphabetical). */
function itemCountLabel(bullets: string[], verbose: boolean): string {
  if (verbose) {
    const bd = typeBreakdown(bullets);
    if (bd.length === 0) return '(0 items)';
    return `(${bd.map((b) => `${b.count} ${b.type}`).join(', ')})`;
  }
  const n = bullets.length;
  return `(${n} item${n === 1 ? '' : 's'})`;
}

/** Render the version list for the `ls` subcommand: aligned version + date +
 *  item count, colored on a TTY and plain when piped. */
function versionList(versions: Section[], unreleased: Section | undefined, tty: boolean, verbose: boolean): string {
  const c = (s: string, code: string) => (tty ? `${code}${s}${reset}` : s);
  const rows: [string, string, string][] = [];
  if (unreleased) {
    rows.push([
      'Unreleased',
      headerDate(unreleased.raw) || 'in flight',
      itemCountLabel(extractBullets(unreleased.raw), verbose),
    ]);
  }
  for (const v of versions) rows.push([v.version!, headerDate(v.raw), itemCountLabel(extractBullets(v.raw), verbose)]);
  if (rows.length === 0) return c('(no versions)', dim);

  const w = Math.max(...rows.map(([v]) => v.length));
  const dw = Math.max(...rows.map(([, d]) => d.length));
  const head = c(`Available versions — ${versions.length} released${unreleased ? ' + Unreleased' : ''}`, bold);
  const lines = rows.map(([v, d, cnt]) => `  ${c(v.padEnd(w), cyan)}  ${c(d.padEnd(dw), dim)}  ${c(cnt, dim)}`);
  return `${head}\n${lines.join('\n')}`;
}

/** The one-line "change statement" for a bullet: its leading **bold** summary,
 *  else its first sentence. Inline `code` and em-dashes are kept as Markdown so
 *  the compact view renders (TTY) or pipes (raw) through the same path. */
function summarize(content: string): string {
  const t = content.trim();
  if (t.startsWith('**')) {
    const end = t.indexOf('**', 2);
    if (end !== -1) return t.slice(2, end).trim();
  }
  const sentence = t.match(/^(.*?[.!?])(\s|$)/);
  return (sentence ? sentence[1] : t).trim();
}

/** Rebuild a section as compact Markdown: the header (with its item count)
 *  plus one bullet per top-level change, each reduced to its change statement. */
function compactSection(raw: string): string {
  let title = '';
  const items: string[] = [];
  const rawBullets: string[] = [];
  for (const line of raw.split('\n')) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      title = h[1].trim();
      continue;
    }
    const b = line.match(/^[-*]\s+(.*)$/); // top-level bullets only
    if (b) {
      rawBullets.push(b[1].trim());
      items.push(summarize(b[1]));
    }
  }
  const body = items.map((s) => `- ${s}`).join('\n');
  return `## ${title} ${itemCountLabel(rawBullets, false)}\n\n${body}`;
}

function main(): void {
  let text: string;
  try {
    text = readFileSync(CHANGELOG, 'utf8');
  } catch {
    console.error(`${red}Could not read CHANGELOG.md at ${CHANGELOG}${reset}`);
    process.exit(1);
  }

  const sections = parseSections(text);
  const versions = sections.filter((s) => s.kind === 'version'); // newest-first (file order)
  const unreleased = sections.find((s) => s.kind === 'unreleased');

  const rawArgs = process.argv.slice(2);
  if (rawArgs.some((a) => a === '-h' || a === '--help' || a === 'help')) {
    console.log(usage(versions));
    return;
  }
  const verbose = rawArgs.some((a) => a === '-v' || a === '--verbose');
  const outIdx = rawArgs.indexOf('--out');
  const outPath = outIdx !== -1 ? rawArgs[outIdx + 1] : undefined;
  const positionals = rawArgs.filter(
    (a, i) => a !== '-v' && a !== '--verbose' && (outIdx === -1 || (i !== outIdx && i !== outIdx + 1)),
  );
  const argRaw = (positionals[0] ?? 'latest').trim();
  const arg = argRaw.toLowerCase();

  if (arg === 'ls' || arg === 'list') {
    console.log(versionList(versions, unreleased, process.stdout.isTTY, verbose));
    return;
  }

  if (arg === 'json') {
    const json = JSON.stringify(sectionsToJson(sections), null, 2);
    if (outPath) {
      writeFileSync(resolve(outPath), json + '\n', 'utf8');
    } else {
      console.log(json);
    }
    return;
  }

  let chosen: Section | undefined;
  let note = '';

  if (arg === '' || arg === 'latest') {
    chosen = versions[0] ?? unreleased;
    if (!versions[0] && unreleased) note = 'No released versions yet — showing Unreleased.';
  } else if (arg === 'unreleased') {
    chosen = unreleased;
    if (!chosen) {
      console.error(`${red}No ## Unreleased section in CHANGELOG.md${reset}`);
      process.exit(1);
    }
  } else {
    const q = parseQuery(arg);
    if (!q) {
      console.error(`${red}Unrecognized argument: '${argRaw}'${reset}\n`);
      console.error(usage(versions));
      process.exit(1);
    }
    if (versions.length === 0) {
      console.error(`${red}No released versions in CHANGELOG.md${reset}`);
      process.exit(1);
    }
    // Exact match wins at distance 0; otherwise closest. `versions` is
    // newest-first and we update only on strictly-smaller distance, so the
    // newest version wins any tie.
    let best = versions[0];
    let bestD = distance(q, best.parts!);
    for (const v of versions) {
      const d = distance(q, v.parts!);
      if (d < bestD) {
        best = v;
        bestD = d;
      }
    }
    chosen = best;
    if (bestD > 0) note = `'${argRaw}' not found — showing closest: ${best.version}`;
  }

  if (!chosen) {
    console.error(`${red}Nothing to show.${reset}`);
    process.exit(1);
  }

  if (note) console.error(`${yellow}⚠ ${note}${reset}`);

  // Verbose → full entry text; default → one-line change statements per bullet.
  const md = verbose ? chosen.raw : compactSection(chosen.raw);

  // Interactive terminal → pretty ANSI. Piped/redirected → raw Markdown, so a
  // `> file.md` capture stays clean (no color codes, no wrapping).
  if (process.stdout.isTTY) {
    console.log(renderMarkdown(md));
  } else {
    console.log(md);
  }
}

main();
