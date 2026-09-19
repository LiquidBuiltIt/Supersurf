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
/** Bind a minted name to the selector it describes, for this session only. */
export declare function bindEphemeral(sessionId: string, name: string, selector: string): void;
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
 */
export declare function resolveEphemeral(name: string): string | null;
//# sourceMappingURL=ephemeral-handles.d.ts.map