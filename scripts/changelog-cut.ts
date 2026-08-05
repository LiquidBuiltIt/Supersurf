/**
 * Pure changelog-cutting logic used by `version.bump.ts`. Moves everything
 * under `## Unreleased` in CHANGELOG.md into a new `## X.Y.Z — YYYY-MM-DD`
 * section, leaving a fresh empty `## Unreleased` behind.
 *
 * Parsing conventions match `scripts/changelog.ts` and the parser-contract
 * comment atop CHANGELOG.md: `## ` headers at column 0, `## Unreleased`
 * matched case-insensitively as a whole line, a section runs until the next
 * `## ` line (or EOF).
 */

const UNRELEASED_HEADER = /^##\s+Unreleased\s*$/i;
const VERSION_HEADER = /^##\s+v?(\d+)\.(\d+)\.(\d+)\b/;

export interface CutSuccess {
  content: string;
  moved: number;
}

export interface CutWarning {
  warning: string;
}

/**
 * Cuts the `## Unreleased` section of `content` into a new
 * `## <version> — <date>` section.
 *
 * - Normal case: returns `{ content, moved }` — the rewritten file and the
 *   number of bullets moved.
 * - Empty or missing `## Unreleased` section: returns `{ warning }` and the
 *   caller should proceed with the bump untouched — never blocks a release.
 * - A `## <version>` section already exists: throws. The caller should abort
 *   the whole bump before writing or committing anything.
 */
export function cutUnreleased(content: string, version: string, date: string): CutSuccess | CutWarning {
  const lines = content.split('\n');

  for (const line of lines) {
    const m = line.match(VERSION_HEADER);
    if (m && `${m[1]}.${m[2]}.${m[3]}` === version) {
      throw new Error(`CHANGELOG.md already has a "## ${version}" section — aborting before touching anything.`);
    }
  }

  const unreleasedIdx = lines.findIndex((l) => UNRELEASED_HEADER.test(l));
  if (unreleasedIdx === -1) {
    return { warning: 'No "## Unreleased" section found in CHANGELOG.md — skipping changelog cut.' };
  }

  let sectionEnd = lines.length;
  for (let i = unreleasedIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      sectionEnd = i;
      break;
    }
  }

  const body = lines.slice(unreleasedIdx + 1, sectionEnd);
  let start = 0;
  while (start < body.length && body[start].trim() === '') start++;
  let end = body.length;
  while (end > start && body[end - 1].trim() === '') end--;
  const bullets = body.slice(start, end);

  if (bullets.length === 0) {
    return { warning: '"## Unreleased" section is empty — nothing to cut, proceeding with bump.' };
  }

  const tail = lines.slice(sectionEnd);
  const newLines = [
    ...lines.slice(0, unreleasedIdx + 1),
    '',
    `## ${version} — ${date}`,
    '',
    ...bullets,
    ...(tail.length > 0 ? ['', ...tail] : []),
  ];

  return { content: newLines.join('\n'), moved: bullets.length };
}
