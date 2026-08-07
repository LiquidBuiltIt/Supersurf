/**
 * Pure changelog parsing + JSON shaping, split out of `changelog.ts` so it
 * can be unit tested without executing that file's CLI `main()` (same
 * pattern as `changelog-cut.ts` next to `version.bump.ts`). Every export
 * here is side-effect free.
 */

export type Parts = [number, number, number];

export interface Section {
  kind: 'unreleased' | 'version';
  version?: string; // e.g. "3.2.0" for version sections
  parts?: Parts;
  raw: string; // full section text incl. the `## ` header, trailing blanks trimmed
}

// Reads only the version number; the ` — <date>` suffix (em dash) is ignored.
const VERSION_HEADER = /^##\s+v?(\d+)\.(\d+)\.(\d+)\b/;
const UNRELEASED_HEADER = /^##\s+Unreleased\s*$/i;

/** Split the changelog into `## ` sections (the `# Changelog` preamble is ignored). */
export function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: string[] | null = null;

  const flush = () => {
    if (!current) return;
    const header = current[0];
    const raw = current.join('\n').replace(/\n+$/, '');
    const vm = header.match(VERSION_HEADER);
    if (vm) {
      sections.push({
        kind: 'version',
        version: `${vm[1]}.${vm[2]}.${vm[3]}`,
        parts: [Number(vm[1]), Number(vm[2]), Number(vm[3])],
        raw,
      });
    } else if (UNRELEASED_HEADER.test(header)) {
      sections.push({ kind: 'unreleased', raw });
    }
    // any other `## ` header (none expected) is dropped
    current = null;
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return sections;
}

/** The date trailing a section header (`## 3.2.0 — 2026-07-03` → `2026-07-03`). */
export function headerDate(raw: string): string {
  const first = raw.split('\n', 1)[0];
  const m = first.match(/—\s*(.+?)\s*$/);
  return m ? m[1].trim() : '';
}

/** Top-level bullet text for a section, raw Markdown intact (per parser
 *  contract item 4: "- " or "* " at column 0 only — nested bullets are
 *  invisible here, same as everywhere else in this file). */
function extractBullets(raw: string): string[] {
  const bullets: string[] = [];
  for (const line of raw.split('\n')) {
    const b = line.match(/^[-*]\s+(.*)$/);
    if (b) bullets.push(b[1].trim());
  }
  return bullets;
}

export interface ChangelogJsonSection {
  version: string; // "X.Y.Z", or "Unreleased" for the in-flight section
  date: string | null; // "YYYY-MM-DD", or null for Unreleased
  bullets: string[];
}

export interface ChangelogJson {
  sections: ChangelogJsonSection[];
}

/** Every parsed section as JSON, in `parseSections` order (newest-first,
 *  Unreleased — if present — leading). */
export function sectionsToJson(sections: Section[]): ChangelogJson {
  return {
    sections: sections.map((s) => ({
      version: s.kind === 'unreleased' ? 'Unreleased' : s.version!,
      date: s.kind === 'unreleased' ? null : headerDate(s.raw),
      bullets: extractBullets(s.raw),
    })),
  };
}
