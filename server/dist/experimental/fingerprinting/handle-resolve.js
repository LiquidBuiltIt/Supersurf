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
exports.HANDLE_MARKER = void 0;
exports.looksLikeHandle = looksLikeHandle;
exports.isHandleRef = isHandleRef;
exports.handleMissHint = handleMissHint;
exports.resolveHandleName = resolveHandleName;
exports.resolveSelectorOrHandle = resolveSelectorOrHandle;
const store_1 = require("./store");
const naming_1 = require("./naming");
const url_1 = require("./url");
const index_1 = require("../index");
const ephemeral_handles_1 = require("./ephemeral-handles");
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
exports.HANDLE_MARKER = '@';
/**
 * True when a selector-slot string explicitly declares itself a handle reference
 * via the leading `@` marker — the ONLY test `resolveSelectorOrHandle` uses to
 * decide whether to attempt translation. No shape inspection, no ambiguity: a bare
 * `submit_review` is always a CSS selector; `@submit_review` is always a handle.
 */
function isHandleRef(s) {
    return typeof s === 'string' && s.startsWith(exports.HANDLE_MARKER) && s.length > exports.HANDLE_MARKER.length;
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
        const name = raw.slice(exports.HANDLE_MARKER.length);
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
 * error.
 *
 * A HIT is the interesting case, and this comment used to assert "there is no
 * path on which a handle can resolve to the wrong element". There was one, it
 * shipped in 2be4745, and it took a browser to find it: the element-miss hint
 * bound a handle to the *displayed* candidate selector, which is built for
 * readability, so on markup carrying no id and no class (news.ycombinator.com)
 * three separate handles all bound to the bare selector `a`, all resolved to the
 * first anchor in the document, and `click` reported success. Two narrower and
 * actually-true statements replace it:
 *
 *   - At MINT time, the qualification ladder (`tools/lib/selector-qualify.ts`)
 *     climbs until the selector re-resolves to the element it describes, and the
 *     candidate builder (`tools/lib/element-resolver.ts`) mints no handle at all
 *     when no rung verifies. A binding therefore starts out unambiguous against
 *     the page as it was at mint time.
 *   - At RESOLVE time, `checkEphemeralIdentity` re-reads the resolved element's
 *     text or label and refuses to act when it no longer matches the fact the
 *     name was taken from. That is what covers the page changing afterwards, and
 *     on the paths that reach it, it throws a typed error precisely so the
 *     fingerprint heal and the child-frame walk cannot re-resolve past it.
 *
 * What is still NOT guaranteed, so nobody rebuilds the old confidence: a binding
 * whose `matchSource` is null — neither text nor label survived sanitization —
 * has no fact to compare and fails OPEN, riding on mint-time qualification
 * alone; coordinate drift is reported in the mismatch message but never causes
 * one, because coordinates move legitimately and text identity does not; the
 * guard covers EPHEMERAL bindings only, since a stored handle's selector is
 * vetted by the fingerprint score gate instead; and the guard sits on the
 * COORDINATE path (`ctx.getElementCenter` → `resolveWithHealing`), so only
 * `click`, `hover` and `drag` reach it — `type`, `clear`, `select_option`,
 * `scroll`, `wait`, `file_upload` and `browser_fill_form` resolve through
 * `resolveInFrames` and never run the check at all (backlog #58).
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
    const name = selector.slice(exports.HANDLE_MARKER.length);
    // ORDER IS THE WHOLE DESIGN. The persistent store is tier 1; the session's
    // ephemeral map is tier 2, consulted ONLY after the store misses. Reversing
    // them lets a freshly minted hint name that collides on text shadow a real
    // persisted handle, which breaks the "first name sticks" invariant enforced
    // in handle-meta.ts:49-60.
    if (index_1.experimentRegistry.isEnabled('fingerprinting')) {
        const domain = (0, url_1.domainOf)(url);
        // Nothing is ever persisted into the 'unknown' bucket (see captureOnResolve),
        // so there is nothing to resolve against.
        if (domain !== 'unknown') {
            const handle = resolveHandleName(domain, (0, url_1.routeOf)(url), name);
            if (handle)
                return { selector: handle.selector, handle, attempted: true };
        }
    }
    // Tier 2, and DELIBERATELY OUTSIDE the experiment gate. The "Did you mean?"
    // hint that mints these names is ungated, so gating the lookup would print
    // `@handles` that cannot resolve on the default configuration. The persistent
    // store stays gated above — that is the experiment's data; this map is not.
    const binding = (0, ephemeral_handles_1.resolveEphemeralBinding)(name);
    if (binding) {
        return {
            selector: binding.selector,
            handle: null,
            attempted: true,
            ephemeral: true,
            ephemeralBinding: binding,
        };
    }
    return { selector: name, handle: null, attempted: true };
}
//# sourceMappingURL=handle-resolve.js.map