import type { FingerprintRecord } from './types';
/** True when `s` is shaped like a handle name rather than a CSS selector. */
export declare function looksLikeHandle(s: string): boolean;
/** A handle name matched to a stored record. */
export interface HandleResolution {
    /** The stored selector to actually query with. */
    selector: string;
    record: FingerprintRecord;
    /** How many records in this domain+route carried the name. */
    candidateCount: number;
}
/**
 * Look up a handle name in one domain store. Single file read (`loadDomain`),
 * never per-record `getRecord`.
 *
 * A name matches only a record's canonical `handleName` — there is no second tier.
 * The first name an element is given is permanently sticky, so a loosely reused name
 * has no path to bind to an element it was never the canonical name for.
 *
 * Multiple records legitimately carry the same name (the same element captured under
 * two selector keys), so ties break on hits then recency rather than rejecting.
 *
 * Scoped to the exact `route` — route templating is deferred.
 */
export declare function resolveHandleName(domain: string, route: string, name: string): HandleResolution | null;
/** What a translation attempt produced. */
export interface SelectorOrHandle {
    /** The selector to query with — the translated one on a hit, the input otherwise. */
    selector: string;
    /** Non-null only when a handle name matched a stored record. */
    handle: HandleResolution | null;
    /** True when the input looked like a handle and a lookup actually ran, so a
     *  `null` handle means "miss", not "this was a plain selector". */
    attempted: boolean;
}
/**
 * The single gated entry point for handle translation. Idempotent: a real CSS
 * selector (or an already-translated one) costs one regex test and comes back
 * unchanged, so every existing call path is untouched.
 *
 * A miss deliberately returns the input rather than throwing — the caller then
 * runs the normal CSS path, which either finds a real element with that name
 * (correct, it WAS a selector) or produces the normal not-found error. There is
 * no path on which a handle can resolve to the wrong element.
 */
export declare function resolveSelectorOrHandle(url: string | undefined, selector: string): SelectorOrHandle;
//# sourceMappingURL=handle-resolve.d.ts.map