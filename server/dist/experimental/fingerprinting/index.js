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
const ephemeral_handles_1 = require("./ephemeral-handles");
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
async function resolveWithHealing(evalFn, selector, getUrl, emit, meta, emitHandle, getSessionId) {
    const url = getUrl();
    const domain = (0, url_2.domainOf)(url), route = (0, url_2.routeOf)(url);
    // Translate a handle reference to the selector it was captured against. Must
    // happen before anything else — including the experiment-gate check below:
    // `query` is used as the page query, the capture key AND the heal key, and a
    // stray `@` marker left in place would be a syntactically invalid CSS selector
    // on all three, gate on or off.
    const translated = (0, handle_resolve_1.resolveSelectorOrHandle)(url, selector);
    const query = translated.selector;
    if (!index_1.experimentRegistry.isEnabled('fingerprinting')) {
        try {
            const center = await (0, element_resolver_1.getElementCenter)(evalFn, query, getSessionId?.());
            // Ephemeral tier-2 resolution is deliberately OUTSIDE the experiment gate
            // (handle-resolve.ts:175-180), so the identity guard must be too —
            // guarding only the gate-on path would leave the default configuration
            // unprotected, which is the configuration the defect was found on.
            const guard = translated.ephemeralBinding
                ? (0, ephemeral_handles_1.checkEphemeralIdentity)(selector.replace(/^@/, ''), translated.ephemeralBinding.facts, center)
                : null;
            if (guard)
                throw guard;
            return center;
        }
        catch (missErr) {
            if (missErr instanceof ephemeral_handles_1.EphemeralIdentityError)
                throw missErr;
            // Tag the provenance before it leaves: downstream fallbacks (the
            // child-frame walk in `getCenterInFrame`) must refuse to substitute an
            // element for a handle minted against the top frame. See `markEphemeralMiss`.
            if (translated.ephemeralBinding)
                (0, ephemeral_handles_1.markEphemeralMiss)(missErr);
            // The feature is off, but the shape/marker still tells the agent something
            // useful: either they used `@name` (translation just doesn't run while the
            // experiment is disabled) or the shape alone suggests they meant to.
            if (missErr instanceof Error)
                missErr.message += (0, handle_resolve_1.handleMissHint)(selector);
            throw missErr;
        }
    }
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
        const center = await (0, element_resolver_1.getElementCenter)(evalFn, query, getSessionId?.());
        const guard = translated.ephemeralBinding
            ? (0, ephemeral_handles_1.checkEphemeralIdentity)(selector.replace(/^@/, ''), translated.ephemeralBinding.facts, center)
            : null;
        // Thrown BEFORE capture and telemetry: a mismatch is not a resolve, and
        // writing a fingerprint for an element we just proved is the wrong one
        // would poison the store.
        if (guard)
            throw guard;
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
        // A proven-wrong element must never be rescued by a heal: healing would
        // re-resolve and hand back coordinates for something we already rejected.
        if (missErr instanceof ephemeral_handles_1.EphemeralIdentityError)
            throw missErr;
        // Same provenance tag as the gate-off branch above.
        if (translated.ephemeralBinding) {
            (0, ephemeral_handles_1.markEphemeralMiss)(missErr);
            // ...and a PLAIN miss on an ephemeral binding refuses the heal outright,
            // for the same reason `getCenterInFrame` refuses the child-frame walk.
            // The heal matches by stored FINGERPRINT against a domain+route+selector
            // key; an ephemeral binding is session-scoped and was minted against one
            // specific element in the top frame. A record filed under the same
            // selector string is not evidence of the same element — the defect this
            // guard exists for (news.ycombinator.com) is precisely a selector that
            // matches many elements. Worse, a heal returns `text: ''` by
            // construction, so `checkEphemeralIdentity` could not vet its result even
            // if it were called. Fail closed: no identity check is possible, so no
            // action. (The gate-OFF branch above never reaches `healOnMiss` at all,
            // so it needs no equivalent — checked, not assumed.)
            //
            // Telemetry: this path still ends in exactly one terminal event, and
            // 'escalated' is already that event — the resolve ended with no
            // coordinates and the error went back to the agent. score/margin are null
            // and hadRecord false because nothing was scored and the store was never
            // read, identical to the existing `catch` arm below when `healOnMiss`
            // throws. No new `outcome` member: a refusal is an escalation with a
            // narrower cause, not a new resolve outcome for the metrics trail.
            fire('escalated', null, null, false);
            // The message-augmentation block below is skipped deliberately, not
            // dropped: an ephemeral binding always carries `attempted: true` AND
            // `ephemeral: true` (`handle-resolve.ts:224-226`), so both of its arms are
            // already false on this path and it appends nothing today.
            throw missErr;
        }
        try {
            const attempt = await healOnMiss(evalFn, url, query);
            if (attempt.hit) {
                fire('healed', attempt.score, attempt.margin, true);
                // A heal matches by fingerprint, not by a live text read, so it has no
                // identity text to report. Empty, never invented.
                return { x: attempt.hit.cx, y: attempt.hit.cy, text: '', label: '' };
            }
            fire('escalated', attempt.score, attempt.margin, attempt.hadRecord);
        }
        catch {
            fire('escalated', null, null, false);
        }
        if (missErr instanceof Error) {
            if (translated.attempted && !translated.handle && !translated.ephemeral) {
                // An unresolved handle that also failed as a CSS selector: say so, so the agent
                // stops retrying the name and looks the element up for itself.
                missErr.message +=
                    `\n\nThere is no recorded handle named \`${query}\` on ${domain}${route}. ` +
                        'Handles resolve only against elements previously interacted with by that name on this route.';
            }
            else if (!translated.attempted) {
                // No `@` marker was used, so translation never ran — but the selector's shape is
                // exactly what a normalized handle name looks like, so the agent may have simply
                // forgotten the marker. Demoted diagnostic only; see `looksLikeHandle`.
                missErr.message += (0, handle_resolve_1.handleMissHint)(selector);
            }
        }
        throw missErr; // escalate = original "Element not found" error
    }
}
//# sourceMappingURL=index.js.map