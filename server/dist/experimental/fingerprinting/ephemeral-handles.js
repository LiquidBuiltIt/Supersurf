"use strict";
// server/src/experimental/fingerprinting/ephemeral-handles.ts
//
// Ephemeral handles: throwaway `@name` aliases minted onto the "Did you mean?"
// candidate list so an agent can paste a suggestion straight back as a selector.
//
// Three properties define this module, and each one is load-bearing:
//
// 1. EPHEMERAL. Nothing here is ever written to the fingerprint store. Only a
//    name the agent itself supplies via `browser_interact`'s `name` param
//    persists — that is the existing `fingerprinting` behaviour and is
//    untouched. These names die with the session.
// 2. TEXT-DERIVED ONLY. A name comes from visible text or the accessible-name
//    attributes, never from id/class/data-testid tokens. An audit of 3,422 real
//    captured elements showed the broader heuristic produces legal-but-garbage
//    names 21% of the time, and 21.4% of real elements have no text, aria-label,
//    placeholder or value at all. Partial coverage IS the design: no confident
//    text source means NO handle for that candidate, and the (now valid) CSS
//    selector prints alone.
// 3. GATE-INDEPENDENT. The hint fires whether or not the `fingerprinting`
//    experiment is on, so the mint and the lookup must too. Gating them the way
//    `handle-annotate.ts:buildHandleIndex` is gated would print `@handles` that
//    silently fail to resolve on the default configuration.
//
// Session state mirrors `ExperimentRegistry._sessions` (experimental/index.ts:53-63):
// keyed by the `connect` `client_id`, bound and dropped from the same two places
// in `backend/handlers.ts`.
Object.defineProperty(exports, "__esModule", { value: true });
exports.EphemeralIdentityError = void 0;
exports.markEphemeralMiss = markEphemeralMiss;
exports.isEphemeralMiss = isEphemeralMiss;
exports.bindSession = bindSession;
exports.dropSession = dropSession;
exports.mintHandleName = mintHandleName;
exports.bindEphemeral = bindEphemeral;
exports.resolveEphemeralBinding = resolveEphemeralBinding;
exports.resolveEphemeral = resolveEphemeral;
exports.checkEphemeralIdentity = checkEphemeralIdentity;
const naming_1 = require("./naming");
const handle_resolve_1 = require("./handle-resolve");
/** Per-session cap. Insertion-ordered Map, oldest evicted first. */
const MAX_PER_SESSION = 200;
/** Most tokens a minted name may carry, so one verbose button can't produce a sentence. */
const MAX_TOKENS = 4;
/**
 * Thrown when an ephemeral handle resolves to an element that is not the one it
 * was minted for. A distinct type, not a plain Error, because two catch blocks
 * must let it through instead of falling back:
 *   - `resolveWithHealing`'s miss branch would try a fingerprint heal
 *     (`fingerprinting/index.ts:261`)
 *   - `getCenterInFrame`'s catch would try the child-frame walk (`frames.ts:355`)
 * Both would re-resolve and act on an element we have just proved is wrong.
 */
class EphemeralIdentityError extends Error {
    ssEphemeralMismatch = true;
    constructor(message) {
        super(message);
        this.name = 'EphemeralIdentityError';
    }
}
exports.EphemeralIdentityError = EphemeralIdentityError;
/**
 * Provenance mark for an ordinary MISS whose selector came from an ephemeral
 * binding. Distinct from `EphemeralIdentityError`, which means "we found an
 * element and it is the wrong one"; this means "the element is simply gone".
 *
 * It exists because the fallback that follows a miss is not always safe. The
 * candidate list an ephemeral handle is minted from is enumerated from the TOP
 * frame only (`findAlternativeSelectors`), so `getCenterInFrame`'s child-frame
 * walk can only ever return an element the handle was never bound to — and
 * nothing on that branch runs `checkEphemeralIdentity`. `resolveWithHealing` is
 * the only code that knows, authoritatively, which resolution tier produced the
 * selector, so it marks the error on the way out rather than making
 * `getCenterInFrame` re-derive the tier from a URL it does not have.
 *
 * `Symbol.for` so the mark survives two module instances (test realms, dual
 * CJS/ESM loads); non-enumerable so it never leaks into a serialized error.
 */
const EPHEMERAL_MISS = Symbol.for('supersurf.ephemeralHandleMiss');
/** Mark a miss error as having come from an ephemeral binding. Returns the same
 *  object so call sites can stay one-liners. */
function markEphemeralMiss(err) {
    if (err && typeof err === 'object') {
        try {
            Object.defineProperty(err, EPHEMERAL_MISS, { value: true, enumerable: false, configurable: true });
        }
        catch { /* frozen error: the mark is best-effort, never a new failure */ }
    }
    return err;
}
/** True when `err` is a miss on a selector an ephemeral binding produced. */
function isEphemeralMiss(err) {
    return !!(err && typeof err === 'object' && err[EPHEMERAL_MISS] === true);
}
/** sessionId -> (handle name -> binding). */
const _sessions = new Map();
/** Monotonic across every session, so "newest" is comparable between them. */
let _seq = 0;
/** Register a session. Called on connect, alongside `experimentRegistry.bind`. */
function bindSession(sessionId) {
    if (!_sessions.has(sessionId))
        _sessions.set(sessionId, new Map());
}
/** Forget every ephemeral name for a session. Called on disconnect. */
function dropSession(sessionId) {
    _sessions.delete(sessionId);
}
/**
 * Mint a handle name from an element's text sources. Returns `null` — meaning
 * "print the CSS selector alone" — whenever no confident source exists.
 *
 * `taken` is the set of names already minted for THIS candidate list; a
 * collision gets a numeric suffix (`got_it`, `got_it_2`). A bare digit is a
 * legal token under HANDLE_RE, so the suffixed form still resolves.
 *
 * A single-token name (`submit`) cannot satisfy the two-or-more-words grammar,
 * so the element's tag is appended (`submit_button`). The tag is structural,
 * not a class token, so this does not reintroduce the garbage-name problem.
 */
function mintHandleName(sources, taken) {
    const raw = (sources.text || '').trim() || (sources.label || '').trim();
    if (!raw)
        return null;
    const base = (0, naming_1.normalizeName)(raw);
    if (!base)
        return null;
    let name = base.split('_').slice(0, MAX_TOKENS).join('_');
    if (!name.includes('_')) {
        const tag = (0, naming_1.normalizeName)(sources.tag);
        if (!tag)
            return null;
        name = `${name}_${tag}`;
    }
    if (!(0, handle_resolve_1.looksLikeHandle)(name))
        return null;
    if (!taken.has(name)) {
        taken.add(name);
        return name;
    }
    for (let n = 2; n <= 50; n++) {
        const candidate = `${name}_${n}`;
        if (!taken.has(candidate) && (0, handle_resolve_1.looksLikeHandle)(candidate)) {
            taken.add(candidate);
            return candidate;
        }
    }
    return null;
}
/** Bind a minted name to the selector it describes plus the facts that prove
 *  the binding is still pointing at the same element, for this session only. */
function bindEphemeral(sessionId, name, selector, facts) {
    if (!sessionId || !name || !selector)
        return;
    let slot = _sessions.get(sessionId);
    if (!slot) {
        slot = new Map();
        _sessions.set(sessionId, slot);
    }
    slot.delete(name); // re-insert so the newest binding is also the newest entry
    slot.set(name, { selector, seq: ++_seq, facts });
    while (slot.size > MAX_PER_SESSION) {
        const oldest = slot.keys().next().value;
        if (oldest === undefined)
            break;
        slot.delete(oldest);
    }
}
/**
 * Look up an ephemeral name. Unions across every bound session, for the same
 * reason `ExperimentRegistry.isEnabled` does with no session id: the sole
 * caller (`resolveSelectorOrHandle`) has no session handle and threading one
 * through its ~15 call sites is BACKLOG #20.
 *
 * The union is safe here specifically because this is the LAST resolution tier —
 * it only ever runs after the persistent store has already missed, so a
 * cross-session name collision can only affect a name that would otherwise have
 * resolved to nothing.
 *
 * Two concurrent sessions CAN mint the same name, though, and assumption A3
 * never covered that case. The winner is the most recently minted binding, not
 * the oldest session: `bindEphemeral` already establishes "latest hint wins"
 * within a session, and iterating `_sessions` in insertion order would have
 * handed the name to whichever session connected first — the opposite rule.
 */
function resolveEphemeralBinding(name) {
    const norm = (0, naming_1.normalizeName)(name);
    if (!norm)
        return null;
    let best = null;
    for (const slot of _sessions.values()) {
        const hit = slot.get(norm);
        if (hit && (!best || hit.seq > best.seq))
            best = hit;
    }
    return best;
}
/** Selector-only form. Kept because most callers want nothing else. */
function resolveEphemeral(name) {
    const b = resolveEphemeralBinding(name);
    return b ? b.selector : null;
}
/** Whitespace-collapsed, trimmed, lower-cased — the comparison form. */
function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
/**
 * Compare an ephemeral handle's mint-time identity against the element its
 * selector actually resolved to. Returns the error to throw, or `null` to
 * proceed. Pure and synchronous, so it is unit-testable with no DOM.
 *
 * Prefix comparison, not equality: the minted value is a <=50-char prefix of
 * the mint-time text (see `ssSafe` in `selector-qualify.ts`), while the
 * resolved value is the full text.
 *
 * Coordinates are reported, never judged — see EphemeralFacts.
 *
 * Absent FACTS fail OPEN (`matchSource: null`, assumption A5): such a handle is
 * legitimately minted — its selector round-trip-verified at mint time — and
 * there is simply nothing to compare, so refusing it would break a handle that
 * was never in doubt. An absent RESOLVED value fails CLOSED: `getElementCenter`
 * normalizes a missing text/label to '', and a fact that did survive gets no
 * benefit of the doubt from an element that reports nothing.
 */
function checkEphemeralIdentity(name, facts, resolved) {
    if (!facts || facts.matchSource === null || !facts.matchValue)
        return null;
    const expected = normText(facts.matchValue);
    const actual = normText(facts.matchSource === 'label' ? resolved.label : resolved.text);
    if (actual.startsWith(expected))
        return null;
    const shown = (s) => (s ? `"${s.slice(0, 60)}"` : '(no text)');
    return new EphemeralIdentityError(`Handle \`@${name}\` no longer identifies the element it was minted for. Nothing was done.\n` +
        `  minted for:  ${shown(facts.matchValue)} at (${facts.x},${facts.y})\n` +
        `  resolved to: ${shown(facts.matchSource === 'label' ? resolved.label : resolved.text)} ` +
        `at (${resolved.x},${resolved.y})\n` +
        `The page changed, or the selector bound to this handle matches more than one element. ` +
        `Target the element with a CSS selector, or re-run the action that produced the ` +
        `"Did you mean?" list to mint a fresh handle.`);
}
//# sourceMappingURL=ephemeral-handles.js.map