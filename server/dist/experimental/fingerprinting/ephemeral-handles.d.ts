/**
 * What a binding must remember so a resolve-time mismatch can be DETECTED.
 *
 * The original binding stored only `{ selector, seq }`. That is exactly why the
 * news.ycombinator.com defect could report success: with the mint-time facts
 * discarded there was nothing left to compare the resolved element against, and
 * the click probe could not help because it derives its target from the same
 * (wrong) query.
 *
 * `matchSource` names which fact the handle's NAME came from, because that is
 * the fact worth guarding — `mintHandleName` uses `text || label`.
 * `matchSource: null` means neither survived sanitization (assumption A5): the
 * handle is still minted, because its selector round-trip-verified at mint
 * time, but no resolve-time text guard can run for it.
 *
 * `x`/`y` are the mint-time centre. Coordinate drift is a SOFT signal only —
 * coordinates move legitimately on scroll, reflow and animation; text identity
 * does not. They appear in the error message, never in the throw decision.
 */
export interface EphemeralFacts {
    matchSource: 'text' | 'label' | null;
    matchValue: string;
    x: number;
    y: number;
}
/** One binding: the selector, the mint-time identity facts, and the global
 *  order in which it was minted. */
export interface EphemeralBinding {
    selector: string;
    /** Monotonic mint counter — the tiebreak when two sessions mint the same name. */
    seq: number;
    facts: EphemeralFacts;
}
/**
 * Thrown when an ephemeral handle resolves to an element that is not the one it
 * was minted for. A distinct type, not a plain Error, because two catch blocks
 * must let it through instead of falling back:
 *   - `resolveWithHealing`'s miss branch would try a fingerprint heal
 *     (`fingerprinting/index.ts:261`)
 *   - `getCenterInFrame`'s catch would try the child-frame walk (`frames.ts:355`)
 * Both would re-resolve and act on an element we have just proved is wrong.
 */
export declare class EphemeralIdentityError extends Error {
    readonly ssEphemeralMismatch = true;
    constructor(message: string);
}
/** Mark a miss error as having come from an ephemeral binding. Returns the same
 *  object so call sites can stay one-liners. */
export declare function markEphemeralMiss<T>(err: T): T;
/** True when `err` is a miss on a selector an ephemeral binding produced. */
export declare function isEphemeralMiss(err: unknown): boolean;
/** Register a session. Called on connect, alongside `experimentRegistry.bind`. */
export declare function bindSession(sessionId: string): void;
/** Forget every ephemeral name for a session. Called on disconnect. */
export declare function dropSession(sessionId: string): void;
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
export declare function mintHandleName(sources: {
    text?: string;
    label?: string;
    tag: string;
}, taken: Set<string>): string | null;
/** Bind a minted name to the selector it describes plus the facts that prove
 *  the binding is still pointing at the same element, for this session only. */
export declare function bindEphemeral(sessionId: string, name: string, selector: string, facts: EphemeralFacts): void;
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
export declare function resolveEphemeralBinding(name: string): EphemeralBinding | null;
/** Selector-only form. Kept because most callers want nothing else. */
export declare function resolveEphemeral(name: string): string | null;
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
export declare function checkEphemeralIdentity(name: string, facts: EphemeralFacts, resolved: {
    x: number;
    y: number;
    text: string;
    label: string;
}): EphemeralIdentityError | null;
//# sourceMappingURL=ephemeral-handles.d.ts.map