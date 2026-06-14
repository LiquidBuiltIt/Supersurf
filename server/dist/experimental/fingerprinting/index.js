"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MARGIN = exports.THRESHOLD = void 0;
exports.domainOf = domainOf;
exports.routeOf = routeOf;
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
exports.THRESHOLD = 0.6;
exports.MARGIN = 0.10;
function domainOf(url) {
    try {
        return new URL(url || '').hostname.replace(/^www\./, '') || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
function routeOf(url) {
    try {
        return new URL(url || '').pathname || '/';
    }
    catch {
        return '/';
    }
}
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
/** Fire-and-forget: fingerprint the just-resolved element and persist it. Never throws. */
async function captureOnResolve(evalFn, url, selector) {
    try {
        const raw = await evalFn((0, page_scripts_1.captureExpr)(selector));
        const fp = safeParse(raw);
        if (!fp)
            return;
        const domain = domainOf(url), route = routeOf(url);
        const existing = (0, store_1.getRecord)(domain, route, selector);
        const now = Date.now();
        const rec = {
            ...fp, selector,
            capturedAt: existing?.capturedAt ?? now,
            lastSeenAt: now,
            hits: (existing?.hits ?? 0) + 1,
        };
        (0, store_1.putRecord)(domain, route, selector, rec);
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
async function captureInContext(evalInContext, url, selector) {
    if (!index_1.experimentRegistry.isEnabled('fingerprinting'))
        return;
    await captureOnResolve(evalInContext, url, selector);
}
/** On a selector miss, try to heal via stored fingerprint. Returns the attempt detail; `hit` is set only when the gate passes. */
async function healOnMiss(evalFn, url, selector) {
    const rec = (0, store_1.getRecord)(domainOf(url), routeOf(url), selector);
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
async function resolveWithHealing(evalFn, selector, getUrl, emit) {
    if (!index_1.experimentRegistry.isEnabled('fingerprinting')) {
        return (0, element_resolver_1.getElementCenter)(evalFn, selector);
    }
    const url = getUrl();
    const domain = domainOf(url), route = routeOf(url);
    const fire = (outcome, score, margin, hadRecord) => {
        try {
            emit?.({ event: 'fingerprint', outcome, selector, domain, route, score, margin, hadRecord });
        }
        catch { /* telemetry must never break a resolve */ }
    };
    try {
        const center = await (0, element_resolver_1.getElementCenter)(evalFn, selector);
        // fire-and-forget capture; do not await (keeps resolve latency unchanged)
        void captureOnResolve(evalFn, url, selector);
        fire('resolved', null, null, false);
        return center;
    }
    catch (missErr) {
        try {
            const attempt = await healOnMiss(evalFn, url, selector);
            if (attempt.hit) {
                fire('healed', attempt.score, attempt.margin, true);
                return { x: attempt.hit.cx, y: attempt.hit.cy };
            }
            fire('escalated', attempt.score, attempt.margin, attempt.hadRecord);
        }
        catch {
            fire('escalated', null, null, false);
        }
        throw missErr; // escalate = original "Element not found" error
    }
}
//# sourceMappingURL=index.js.map