export interface HandleMeta {
    name?: string;
    purpose?: string;
}
export interface MergeResult {
    name?: string;
    purpose?: string;
    aliases?: Record<string, number>;
    outcome: 'new' | 'alias' | 'existing' | 'none';
    addedAlias?: string;
    aliasFreq?: number;
    normalized: boolean;
}
type ExistingHandle = {
    name?: string;
    purpose?: string;
    aliases?: Record<string, number>;
} | undefined;
/**
 * Pure decision of canonical-vs-alias for an incoming (name, purpose) against an existing record.
 * - First-seen name becomes canonical.
 * - A differing normalized name is harvested as an alias (freq++), never overwriting canonical.
 * - purpose: latest non-empty value wins; empty preserves the prior.
 * Never throws.
 */
export declare function mergeHandleMeta(existing: ExistingHandle, incoming: HandleMeta): MergeResult;
export {};
//# sourceMappingURL=handle-meta.d.ts.map