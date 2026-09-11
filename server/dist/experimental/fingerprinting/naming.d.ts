/** Normalize an agent-supplied handle name to snake_case. Never throws.
 *  Returns '' for nullish/empty/punctuation-only input (caller treats '' as "no name").
 *
 *  DECISION: the `@` marker is only meaningful in the SELECTOR slot (see
 *  `handle-resolve.ts`); the capture-time `name` field stays bare. A stray `@`
 *  mistakenly supplied at capture time (e.g. `name: "@submit_review"`) is silently
 *  STRIPPED, not rejected — it falls out of the generic non-alphanumeric collapse
 *  below like any other punctuation, so `"@submit_review"` and `"submit_review"`
 *  normalize to the same stored name. */
export declare function normalizeName(raw: string | undefined | null): string;
/** True when normalizeName(raw) differs from the trimmed input (i.e. it wasn't already canonical). */
export declare function wasNormalized(raw: string | undefined | null): boolean;
//# sourceMappingURL=naming.d.ts.map