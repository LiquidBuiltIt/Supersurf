// server/src/experimental/fingerprinting/naming.ts

/** Normalize an agent-supplied handle name to snake_case. Never throws.
 *  Returns '' for nullish/empty/punctuation-only input (caller treats '' as "no name"). */
export function normalizeName(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return '';
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // any run of non-alphanumerics -> single _
    .replace(/^_+|_+$/g, '');     // strip leading/trailing _
  return s.slice(0, 64);
}

/** True when normalizeName(raw) differs from the trimmed input (i.e. it wasn't already canonical). */
export function wasNormalized(raw: string | undefined | null): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  return normalizeName(raw) !== trimmed;
}
