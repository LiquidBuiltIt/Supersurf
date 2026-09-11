// server/src/experimental/fingerprinting/naming.ts

/** Normalize an agent-supplied handle name to snake_case. Never throws.
 *  Returns '' for nullish/empty/punctuation-only input (caller treats '' as "no name").
 *
 *  DECISION: the `@` marker is only meaningful in the SELECTOR slot (see
 *  `handle-resolve.ts`); the capture-time `name` field stays bare. A stray `@`
 *  mistakenly supplied at capture time (e.g. `name: "@submit_review"`) is silently
 *  STRIPPED, not rejected — it falls out of the generic non-alphanumeric collapse
 *  below like any other punctuation, so `"@submit_review"` and `"submit_review"`
 *  normalize to the same stored name. */
export function normalizeName(raw: string | undefined | null): string {
  if (typeof raw !== 'string') return '';
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // any run of non-alphanumerics -> single _
    .replace(/^_+|_+$/g, '');     // strip leading/trailing _
  return s.slice(0, 64).replace(/^_+|_+$/g, ''); // re-strip: truncation can reintroduce a trailing _
}

/** True when normalizeName(raw) differs from the trimmed input (i.e. it wasn't already canonical). */
export function wasNormalized(raw: string | undefined | null): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  return normalizeName(raw) !== trimmed;
}
