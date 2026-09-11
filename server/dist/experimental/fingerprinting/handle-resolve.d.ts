import type { FingerprintRecord } from './types';
/** True when `s` is shaped like a handle name. Resolution-time callers must use
 *  `isHandleRef` instead; this is for name-shape validation and diagnostics only. */
export declare function looksLikeHandle(s: string): boolean;
/**
 * True when a selector-slot string explicitly declares itself a handle reference
 * via the leading `@` marker — the ONLY test `resolveSelectorOrHandle` uses to
 * decide whether to attempt translation. No shape inspection, no ambiguity: a bare
 * `submit_review` is always a CSS selector; `@submit_review` is always a handle.
 */
export declare function isHandleRef(s: string): boolean;
/**
 * Failure-path advisory for a selector-slot string that missed. Takes the RAW
 * string the agent supplied (marker or not) and picks the diagnostic that
 * actually fits — these are two different situations, not one:
 *
 * - Marker present (`@submit_review`) and the lookup missed: the agent already
 *   did it right — there is simply no handle recorded under that name for this
 *   page. Suggesting `@name` again would be nonsense.
 * - No marker, but the shape is exactly what a normalized handle name looks
 *   like (the old resolution regex, demoted to a diagnostic only): the agent
 *   may have forgotten the marker.
 *
 * Returns '' when neither applies, so callers can unconditionally splice the
 * result into a "not found" message.
 */
export declare function handleMissHint(raw: string): string;
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
 * The single entry point for handle translation. Idempotent: a plain CSS
 * selector (or an already-translated one, which never carries the `@` marker)
 * costs one `startsWith` check and comes back unchanged, so every existing call
 * path is untouched.
 *
 * A miss deliberately returns the (marker-stripped) input rather than throwing —
 * the caller then runs the normal CSS path, which either finds a real element
 * with that name (unlikely, but harmless) or produces the normal not-found
 * error. There is no path on which a handle can resolve to the wrong element.
 *
 * The `@` marker is recognized — and stripped — before the experiment gate below,
 * not after: leaving it in place on a disabled/unknown-domain fallthrough would
 * hand the CSS path a syntactically invalid selector (`@foo`) instead of a clean
 * (if pointless) query for `foo`.
 */
export declare function resolveSelectorOrHandle(url: string | undefined, selector: string): SelectorOrHandle;
//# sourceMappingURL=handle-resolve.d.ts.map