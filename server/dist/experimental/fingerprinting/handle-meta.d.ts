export interface HandleMeta {
    name?: string;
    purpose?: string;
}
export interface MergeResult {
    name?: string;
    purpose?: string;
    outcome: 'new' | 'existing' | 'ignored' | 'none';
    /** The differing name that was NOT stored. Telemetry only — never persisted. */
    ignoredName?: string;
    normalized: boolean;
}
type ExistingHandle = {
    name?: string;
    purpose?: string;
} | undefined;
/**
 * Pure decision of the canonical handle name for an incoming (name, purpose) against an
 * existing record.
 * - First-seen name becomes canonical.
 * - A differing normalized name is a NO-OP: canonical is sticky, and nothing about the
 *   differing name is persisted. It is reported once as `outcome: 'ignored'` so the
 *   naming-drift signal survives in the telemetry trail rather than in the corpus.
 * - purpose: latest non-empty value wins; empty preserves the prior.
 * Never throws.
 */
export declare function mergeHandleMeta(existing: ExistingHandle, incoming: HandleMeta): MergeResult;
export {};
//# sourceMappingURL=handle-meta.d.ts.map