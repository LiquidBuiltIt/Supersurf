"use strict";
// server/src/experimental/fingerprinting/handle-resolve.ts
//
// The read side of playbooks: translate an agent-supplied handle reference
// (`@tweet_button`) back into the selector of the element it was bound to at
// capture time. A selector-slot string is a handle reference only when it
// carries the leading `@` marker — no shape guessing. Pure + synchronous;
// `resolveSelectorOrHandle` checks the `fingerprinting` experiment gate itself,
// so callers don't have to.
Object.defineProperty(exports, "__esModule", { value: true });
exports.looksLikeHandle = looksLikeHandle;
exports.isHandleRef = isHandleRef;
exports.handleMissHint = handleMissHint;
exports.resolveHandleName = resolveHandleName;
exports.resolveSelectorOrHandle = resolveSelectorOrHandle;
const store_1 = require("./store");
const naming_1 = require("./naming");
const url_1 = require("./url");
const index_1 = require("../index");
/**
 * A bare snake_case identifier with at least one underscore — the shape a
 * normalized handle name takes (see `naming.ts`).
 *
 * NOT used to decide whether a selector-slot string is a handle reference —
 * that is `isHandleRef`'s job, on the explicit `@` marker, with zero shape
 * inspection. This regex survives in two other roles: (a) capture-time
 * validation that a stored `handleName` is a shape `resolveHandleName` could
 * ever match again (`handle-meta.ts`, `handle-annotate.ts`), and (b) a
 * failure-path diagnostic (`handleMissHint` below) — never a resolution rule.
 */
const HANDLE_RE = /^[a-z0-9]+(_[a-z0-9]+)+$/;
/** True when `s` is shaped like a handle name. Resolution-time callers must use
 *  `isHandleRef` instead; this is for name-shape validation and diagnostics only. */
function looksLikeHandle(s) {
    return typeof s === 'string' && s.length <= 64 && HANDLE_RE.test(s);
}
/** The marker that declares a selector-slot string a handle reference. */
const HANDLE_MARKER = '@';
/**
 * True when a selector-slot string explicitly declares itself a handle reference
 * via the leading `@` marker — the ONLY test `resolveSelectorOrHandle` uses to
 * decide whether to attempt translation. No shape inspection, no ambiguity: a bare
 * `submit_review` is always a CSS selector; `@submit_review` is always a handle.
 */
function isHandleRef(s) {
    return typeof s === 'string' && s.startsWith(HANDLE_MARKER) && s.length > HANDLE_MARKER.length;
}
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
function handleMissHint(raw) {
    if (isHandleRef(raw)) {
        const name = raw.slice(HANDLE_MARKER.length);
        return `\n\nNo handle named \`${name}\` is recorded for this page.`;
    }
    if (!looksLikeHandle(raw))
        return '';
    return `\n\nIf you meant the handle, target it with \`@${raw}\`.`;
}
/** hits desc, then lastSeenAt desc — the record that has actually been working wins. */
function bestFirst(a, b) {
    return (b.hits - a.hits) || (b.lastSeenAt - a.lastSeenAt);
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
function resolveHandleName(domain, route, name) {
    const norm = (0, naming_1.normalizeName)(name);
    if (!norm)
        return null;
    const byRoute = (0, store_1.loadDomain)(domain).routes[route];
    if (!byRoute)
        return null;
    const candidates = [];
    for (const rec of Object.values(byRoute)) {
        if (rec.handleName === norm)
            candidates.push(rec);
    }
    if (candidates.length === 0)
        return null;
    const record = candidates.sort(bestFirst)[0];
    return { selector: record.selector, record, candidateCount: candidates.length };
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
function resolveSelectorOrHandle(url, selector) {
    if (!isHandleRef(selector)) {
        return { selector, handle: null, attempted: false };
    }
    const name = selector.slice(HANDLE_MARKER.length);
    if (!index_1.experimentRegistry.isEnabled('fingerprinting')) {
        return { selector: name, handle: null, attempted: false };
    }
    const domain = (0, url_1.domainOf)(url);
    // Nothing is ever persisted into the 'unknown' bucket (see captureOnResolve),
    // so there is nothing to resolve against.
    if (domain === 'unknown')
        return { selector: name, handle: null, attempted: false };
    const handle = resolveHandleName(domain, (0, url_1.routeOf)(url), name);
    if (!handle)
        return { selector: name, handle: null, attempted: true };
    return { selector: handle.selector, handle, attempted: true };
}
//# sourceMappingURL=handle-resolve.js.map