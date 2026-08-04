"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeOf = exports.domainOf = exports.MARGIN = exports.THRESHOLD = void 0;
exports.passesGate = passesGate;
exports.captureOnResolve = captureOnResolve;
exports.captureInContext = captureInContext;
exports.healOnMiss = healOnMiss;
exports.healInContext = healInContext;
exports.resolveWithHealing = resolveWithHealing;
const element_resolver_1 = require("../../tools/lib/element-resolver");
const index_1 = require("../index");
const store_1 = require("./store");
const page_scripts_1 = require("./page-scripts");
const handle_meta_1 = require("./handle-meta");
const handle_resolve_1 = require("./handle-resolve");
exports.THRESHOLD = 0.6;
exports.MARGIN = 0.10;
var url_1 = require("./url");
Object.defineProperty(exports, "domainOf", { enumerable: true, get: function () { return url_1.domainOf; } });
Object.defineProperty(exports, "routeOf", { enumerable: true, get: function () { return url_1.routeOf; } });
const url_2 = require("./url");
function passesGate(hit) {
    return hit.score >= exports.THRESHOLD && hit.margin >= exports.MARGIN;
}
function safeParse(s) {
    if (typeof s !== 'string')
        return null;
    try {
        return JSON.parse(s);
    }
    catch {
        return null;
    }
}
/** Fire-and-forget: fingerprint the just-resolved element and persist it, binding an
 *  optional agent-supplied handle name/purpose via mergeHandleMeta (sticky-canonical, never an alias). Never throws.
 *  `preloadedRecord`, when passed (even as `null`), is reused as-is instead of re-reading via
 *  `getRecord` — callers that already looked up the record (e.g. `resolveWithHealing`, for its
 *  `hadRecord` telemetry) pass it through so the happy path stays at one file read, not two. */
async function captureOnResolve(evalFn, url, selector, meta, emitHandle, preloadedRecord) {
    try {
        const raw = await evalFn((0, page_scripts_1.captureExpr)(selector));
        const fp = safeParse(raw);
        if (!fp)
            return;
        const domain = (0, url_2.domainOf)(url), route = (0, url_2.routeOf)(url);
        // Never persist into the 'unknown' bucket: a stale/empty attached-tab URL would
        // mis-file the record under unknown.json where it can never be healed (heal keys
        // off the live domain). Drop it instead — the record is best-effort anyway.
        if (domain === 'unknown')
            return;
        const existing = preloadedRecord !== undefined ? preloadedRecord : (0, store_1.getRecord)(domain, route, selector);
        const now = Date.now();
        const merged = (0, handle_meta_1.mergeHandleMeta)(existing ? { name: existing.handleName, purpose: existing.purpose } : undefined, meta ?? {});
        const rec = {
            ...fp, selector,
            capturedAt: existing?.capturedAt ?? now,
            lastSeenAt: now,
            hits: (existing?.hits ?? 0) + 1,
            // handle fields (only set when present, keeps records that never got a name clean)
            ...(merged.name !== undefined ? { handleName: merged.name } : {}),
            ...(merged.purpose !== undefined ? { purpose: merged.purpose } : {}),
        };
        (0, store_1.putRecord)(domain, route, selector, rec);
        // Emit handle telemetry only when the agent actually supplied a usable name.
        if (emitHandle && merged.outcome !== 'none') {
            try {
                emitHandle({
                    event: 'handle.capture',
                    outcome: merged.outcome,
                    name: merged.name ?? '',
                    ...(merged.ignoredName !== undefined ? { ignoredName: merged.ignoredName } : {}),
                    purpose_present: !!merged.purpose,
                    normalized: merged.normalized,
                    domain, route, selector,
                });
            }
            catch { /* telemetry must never break capture */ }
        }
    }
    catch {
        /* capture is best-effort; never disrupt the resolve */
    }
}
/**
 * Capture an element resolved inside a child frame (iframe). The top-frame capture path
 * (`resolveWithHealing`) can't see iframe elements because it evals against the top frame,
 * so `getCenterInFrame`'s frame-walk fallback calls this with an `evalFn` already bound to
 * the child frame's execution context. Gated + fire-and-forget; never throws.
 */
async function captureInContext(evalInContext, url, selector, meta, emitHandle) {
    if (!index_1.experimentRegistry.isEnabled('fingerprinting'))
        return;
    await captureOnResolve(evalInContext, url, selector, meta, emitHandle);
}
/** On a selector miss, try to heal via stored fingerprint. Returns the attempt detail; `hit` is set only when the gate passes. */
async function healOnMiss(evalFn, url, selector) {
    const rec = (0, store_1.getRecord)((0, url_2.domainOf)(url), (0, url_2.routeOf)(url), selector);
    if (!rec)
        return { hadRecord: false, score: null, margin: null, hit: null };
    const raw = await evalFn((0, page_scripts_1.scoreExpr)(JSON.stringify(rec)));
    const scored = safeParse(raw);
    if (!scored)
        return { hadRecord: true, score: null, margin: null, hit: null };
    return { hadRecord: true, score: scored.score, margin: scored.margin, hit: passesGate(scored) ? scored : null };
}
/**
 * Heal a selector miss inside a child frame (iframe). The top-frame heal path
 * (`resolveWithHealing`) evals against the top frame, so it can't see iframe
 * elements; `getCenterInFrame`'s frame-walk fallback calls this with an `evalFn`
 * already bound to a child frame's execution context. Returns the gate-passing
 * hit's **iframe-local** center + score/margin (the caller translates to
 * top-frame coords), or null when there's no record / the gate fails. Gated;
 * never throws.
 */
async function healInContext(evalInContext, url, selector) {
    if (!index_1.experimentRegistry.isEnabled('fingerprinting'))
        return null;
    try {
        const attempt = await healOnMiss(evalInContext, url, selector);
        return attempt.hit; // non-null ONLY when the gate passed
    }
    catch {
        return null;
    }
}
/**
 * Drop-in wrapper for getElementCenter. When the experiment is OFF, behaves identically
 * to getElementCenter. When ON: captures on success, heals on miss, escalates (rethrows)
 * if healing fails.
 */
async function resolveWithHealing(evalFn, selector, getUrl, emit, meta, emitHandle) {
    if (!index_1.experimentRegistry.isEnabled('fingerprinting')) {
        return (0, element_resolver_1.getElementCenter)(evalFn, selector);
    }
    const url = getUrl();
    const domain = (0, url_2.domainOf)(url), route = (0, url_2.routeOf)(url);
    // Translate a handle name to the selector it was captured against. Must happen
    // before anything else: `query` is used as the page query, the capture key AND
    // the heal key below, and a handle name would miss on all three.
    const translated = (0, handle_resolve_1.resolveSelectorOrHandle)(url, selector);
    const query = translated.selector;
    if (translated.attempted) {
        try {
            emitHandle?.({
                event: 'handle.resolved',
                name: selector,
                match: translated.handle ? 'canonical' : 'miss',
                candidateCount: translated.handle ? translated.handle.candidateCount : 0,
                selector: translated.handle ? query : '',
                domain, route,
            });
        }
        catch { /* telemetry must never break a resolve */ }
    }
    const fire = (outcome, score, margin, hadRecord) => {
        try {
            emit?.({
                event: 'fingerprint', outcome, selector: query, domain, route, score, margin, hadRecord,
                discovery: hadRecord ? 'known' : 'new',
            });
        }
        catch { /* telemetry must never break a resolve */ }
    };
    try {
        const center = await (0, element_resolver_1.getElementCenter)(evalFn, query);
        // Single hoisted read: reused for the `hadRecord` telemetry below AND passed into
        // captureOnResolve so it skips its own getRecord — keeps the happy path at one file
        // read total, not two. (Skip entirely for the 'unknown' domain bucket, which never
        // has records — see captureOnResolve's 'unknown' guard.)
        const existing = domain === 'unknown' ? null : (0, store_1.getRecord)(domain, route, query);
        // fire-and-forget capture; do not await (keeps resolve latency unchanged)
        void captureOnResolve(evalFn, url, query, meta, emitHandle, existing);
        fire('resolved', null, null, !!existing);
        return center;
    }
    catch (missErr) {
        try {
            const attempt = await healOnMiss(evalFn, url, query);
            if (attempt.hit) {
                fire('healed', attempt.score, attempt.margin, true);
                return { x: attempt.hit.cx, y: attempt.hit.cy };
            }
            fire('escalated', attempt.score, attempt.margin, attempt.hadRecord);
        }
        catch {
            fire('escalated', null, null, false);
        }
        // An unresolved handle that also failed as a CSS selector: say so, so the agent
        // stops retrying the name and looks the element up for itself.
        if (translated.attempted && !translated.handle && missErr instanceof Error) {
            missErr.message +=
                `\n\nThere is no recorded handle named \`${selector}\` on ${domain}${route}. ` +
                    'Handles resolve only against elements previously interacted with by that name on this route.';
        }
        throw missErr; // escalate = original "Element not found" error
    }
}
//# sourceMappingURL=index.js.map