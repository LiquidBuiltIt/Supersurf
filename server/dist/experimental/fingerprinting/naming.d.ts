/** Normalize an agent-supplied handle name to snake_case. Never throws.
 *  Returns '' for nullish/empty/punctuation-only input (caller treats '' as "no name"). */
export declare function normalizeName(raw: string | undefined | null): string;
/** True when normalizeName(raw) differs from the trimmed input (i.e. it wasn't already canonical). */
export declare function wasNormalized(raw: string | undefined | null): boolean;
//# sourceMappingURL=naming.d.ts.map