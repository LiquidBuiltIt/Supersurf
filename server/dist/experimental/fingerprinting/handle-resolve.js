"use strict";
// server/src/experimental/fingerprinting/handle-resolve.ts
//
// The read side of playbooks: translate an agent-supplied handle name
// (`tweet_button`) back into the selector of the element it was bound to at
// capture time. Pure + synchronous; `resolveSelectorOrHandle` checks the
// `fingerprinting` experiment gate itself, so callers don't have to.
Object.defineProperty(exports, "__esModule", { value: true });
exports.looksLikeHandle = looksLikeHandle;
exports.resolveHandleName = resolveHandleName;
exports.resolveSelectorOrHandle = resolveSelectorOrHandle;
const store_1 = require("./store");
const naming_1 = require("./naming");
const url_1 = require("./url");
const index_1 = require("../index");
/**
 * A bare snake_case identifier with at least one underscore.
 *
 * The underscore is load-bearing, not cosmetic: `button`, `input`, `a` and
 * `summary` are all valid CSS tag selectors AND valid `normalizeName` output, so
 * accepting single words would make every tag selector ambiguous. Requiring an
 * underscore removes that entire collision class — and an underscore-joined bare
 * identifier is not a realistic tag selector either, since custom-element names
 * must contain a hyphen per the HTML spec.
 */
const HANDLE_RE = /^[a-z0-9]+(_[a-z0-9]+)+$/;
/** True when `s` is shaped like a handle name rather than a CSS selector. */
function looksLikeHandle(s) {
    return typeof s === 'string' && s.length <= 64 && HANDLE_RE.test(s);
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
 * The single gated entry point for handle translation. Idempotent: a real CSS
 * selector (or an already-translated one) costs one regex test and comes back
 * unchanged, so every existing call path is untouched.
 *
 * A miss deliberately returns the input rather than throwing — the caller then
 * runs the normal CSS path, which either finds a real element with that name
 * (correct, it WAS a selector) or produces the normal not-found error. There is
 * no path on which a handle can resolve to the wrong element.
 */
function resolveSelectorOrHandle(url, selector) {
    const miss = { selector, handle: null, attempted: false };
    if (!index_1.experimentRegistry.isEnabled('fingerprinting'))
        return miss;
    if (!looksLikeHandle(selector))
        return miss;
    const domain = (0, url_1.domainOf)(url);
    // Nothing is ever persisted into the 'unknown' bucket (see captureOnResolve),
    // so there is nothing to resolve against.
    if (domain === 'unknown')
        return miss;
    const handle = resolveHandleName(domain, (0, url_1.routeOf)(url), selector);
    if (!handle)
        return { selector, handle: null, attempted: true };
    return { selector: handle.selector, handle, attempted: true };
}
//# sourceMappingURL=handle-resolve.js.map