"use strict";
// server/src/experimental/fingerprinting/handle-annotate.ts
//
// Reader-side handle substitution. Given the URL of the attached tab, build a
// one-shot index from the selector shapes `browser_snapshot` and `browser_lookup`
// synthesise in-page back to the canonical handle name recorded for that element.
//
// ONE `loadDomain` per index build, never one per node. The readers call
// `buildHandleIndex` exactly once per tool call and then probe the returned Map;
// a 200-node snapshot must never turn into 200 store reads.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildHandleIndex = buildHandleIndex;
exports.annotateSelector = annotateSelector;
const store_1 = require("./store");
const url_1 = require("./url");
const index_1 = require("../index");
const handle_resolve_1 = require("./handle-resolve");
/**
 * Derived selector shapes a record could plausibly be recognised by downstream —
 * everything EXCEPT the record's own stored selector (that one is registered
 * separately, in its own pass; see `buildHandleIndex`).
 *
 * Exact-string keys only — no fuzzy matching. The `browser_snapshot` form-field
 * collector (tools/content.ts:104-115) synthesises `tag#id` first,
 * `tag[name="..."]` second and a class-based shape third; `browser_lookup`'s
 * in-page collector (tools/content.ts:227-234) emits `tag#id`, a class-based
 * shape, or `tag[role="..."]`, and has no `[name="..."]` branch — the
 * `tag[name="..."]` derived key exists for the snapshot collector. Neither
 * collector ever emits a bare `#id` — both always prepend the tag name first — so
 * a bare `#id` key is not derived; a record whose own stored selector genuinely is
 * `#foo` is already covered by the own-selector pass.
 *
 * KNOWN MISS — escaping. Both collectors now emit `CSS.escape(id)`, while the
 * keys below are built from the RAW `rec.htmlId`. A digit-leading id, or one
 * carrying `:` or `/` (a Tailwind-style or framework-generated id), therefore
 * escapes in the rendered selector and never matches its derived key, so the
 * field renders without its handle. That is a missing annotation, never a wrong
 * one. It has always applied to `browser_lookup`; it now applies to the snapshot
 * form-field collector too, which gained `CSS.escape` in the same change.
 *
 * KNOWN MISS — qualification. Both collectors run the built selector through
 * `qualify` (tools/lib/selector-qualify.ts), which APPENDS a `:has-text("...")`,
 * an attribute clause or a whole `:nth-of-type` path when the readable form does
 * not resolve back to its own element. A qualified selector is no longer an exact
 * match for any key here, so it too renders without its handle. This is why a
 * radio group annotates at most its first field: `ssResolve('input[name="x"]')`
 * returns the first match, so only that one keeps the unqualified key.
 *
 * Class-based shapes (`tag.a.b`) are deliberately NOT indexed: framework-hashed
 * class names churn between deploys and the collectors truncate to the first two
 * classes in DOM order, so a class key would produce confident wrong answers. A
 * miss renders exactly as it does today, which is the correct failure mode.
 */
function derivedKeysFor(rec) {
    const keys = [];
    const tag = rec.tag || '';
    if (tag && rec.htmlId)
        keys.push(`${tag}#${rec.htmlId}`);
    const nameAttr = rec.attrs?.name;
    if (tag && nameAttr)
        keys.push(`${tag}[name="${nameAttr}"]`);
    return keys;
}
/**
 * Build the handle index for the page at `url`.
 *
 * Returns an empty index when the `fingerprinting` experiment is off, the URL has
 * no usable domain, or nothing was ever recorded on this exact route — callers then
 * render exactly as they did before. Never throws.
 */
function buildHandleIndex(url) {
    const index = new Map();
    if (!index_1.experimentRegistry.isEnabled('fingerprinting'))
        return index;
    const domain = (0, url_1.domainOf)(url);
    // Nothing is ever persisted into the 'unknown' bucket (see captureOnResolve).
    if (domain === 'unknown')
        return index;
    try {
        const byRoute = (0, store_1.loadDomain)(domain).routes[(0, url_1.routeOf)(url)];
        if (!byRoute)
            return index;
        // Also excludes any pre-fix corpus record whose handleName was stored before
        // mergeHandleMeta started rejecting single-word (non-underscored) names.
        const named = Object.values(byRoute).filter((rec) => rec.handleName && (0, handle_resolve_1.looksLikeHandle)(rec.handleName));
        // Two passes so a record's OWN stored selector always wins its exact-match slot,
        // even when another record's DERIVED key would otherwise land on that same string
        // first. Two records can legitimately describe the same element under different
        // selector keys (see handle-resolve.ts:53-54) — without this ordering, record A's
        // derived `tag#foo` could occupy the slot before record B's own stored selector of
        // `tag#foo` is ever tried, permanently binding the wrong handle name to it.
        for (const rec of named) {
            // First writer wins among stored selectors too, in case two records were ever
            // stored under the identical selector string (should not happen, but cheap to keep safe).
            if (!index.has(rec.selector))
                index.set(rec.selector, rec.handleName);
        }
        for (const rec of named) {
            for (const key of derivedKeysFor(rec)) {
                if (!index.has(key))
                    index.set(key, rec.handleName);
            }
        }
    }
    catch {
        return index; // annotation is cosmetic; never break a read tool
    }
    return index;
}
/**
 * Render a selector for agent-facing output, substituting the recorded handle when
 * there is one. An unrecorded selector comes back byte-identical.
 *
 * FORMAT NOTE: `name [selector]` — handle first, the CSS kept alongside it so the
 * agent always retains a working fallback. This shape is a deliberately cheap swap:
 * if it ever costs us accuracy, change the template on the line below (and its test).
 * Nothing downstream parses this string.
 */
function annotateSelector(index, selector) {
    if (index.size === 0)
        return selector;
    const name = index.get(selector);
    return name ? `${name} [${selector}]` : selector;
}
//# sourceMappingURL=handle-annotate.js.map