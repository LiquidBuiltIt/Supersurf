/** Async page evaluator signature (matches the inner closure of `evalExpr`). */
export type EvalFn = (expression: string, awaitPromise?: boolean) => Promise<any>;
/**
 * Convert a CSS selector (with optional `:has-text("...")`) into a JS
 * expression that resolves to the matching Element or null. The
 * `:has-text` form is a SuperSurf extension — the page-eval falls back
 * to scanning textContent when the selector includes it.
 *
 * Both branches pierce open shadow roots via `queryDeep`/`queryAllDeep`
 * (see `shared/dom/shadow-walker.ts`) — light DOM is tried first, shadow
 * roots are only walked on a miss, so a selector that resolves today keeps
 * resolving to the same element. Each returned expression is a self-contained
 * IIFE carrying its own copy of the walker function, since callers splice
 * the result directly into a larger expression (e.g. `const el = ${expr};`).
 */
export declare function getSelectorExpression(selector: string): string;
/**
 * The plural of `getSelectorExpression`: a JS expression resolving to an ARRAY
 * of every matching Element, empty when nothing matches.
 *
 * `browser_extract_content` in selector mode used the singular form and so read
 * only the first match — `.WorkflowJob` on a GitHub Actions run page matches
 * many jobs and reported `total: 1`. Callers that genuinely want one element
 * keep using `getSelectorExpression`; this is for the ones that should never
 * have been narrowed.
 *
 * Same two branches, same shadow-piercing walker, same digit-leading-id
 * rewrite — the ONLY difference is that `:has-text(...)` filters the full match
 * set instead of returning on the first hit.
 */
export declare function getAllSelectorExpression(selector: string): string;
/** One "Did you mean?" suggestion, after server-side ranking. */
export interface AltCandidate {
    /** A valid CSS selector the agent can paste straight back. */
    selector: string;
    visible: boolean;
    /** Direct text content, trimmed and capped. */
    text?: string;
    /** First non-empty accessible-name source: aria-label, title, placeholder, value, alt. */
    label?: string;
    tag: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** Token-overlap score; 0 for text-matched and interactive-fallback candidates. */
    score: number;
    /** Ephemeral handle name, minted in Task 4. Absent when no confident text source exists. */
    handle?: string;
}
/**
 * Rank and trim raw page candidates. Pure — all ordering policy lives here
 * rather than in page code, so it is unit-testable without a DOM.
 *
 * Visible candidates first, highest token score first, original order as the
 * final tiebreak. Hidden and zero-area candidates are appended ONLY when the
 * visible list is thin (< VISIBLE_FLOOR) and are capped at HIDDEN_CAP: a
 * selector that matched two hidden 0×0 twins is exactly the failure that made
 * `click` report success at (0,0), so they must never crowd out real answers.
 */
export declare function rankAlternatives(raw: AltCandidate[]): AltCandidate[];
/**
 * Render the agent-facing hint block. Two lines per candidate: the metadata
 * line (with the ephemeral `@handle` when one was minted) and the selector on
 * its own line so it can be copied cleanly.
 *
 * Nothing downstream parses this string — change the template freely, but
 * change its test with it.
 */
export declare function renderAlternatives(alts: AltCandidate[]): string;
/**
 * Find candidate elements for a failing selector.
 *
 * Two strategies, picked on the shape of the input:
 *   - `:has-text("...")` — scan for elements whose DIRECT text contains the phrase.
 *   - anything else — loosened token match (`playbooks/candidates.ts:selectorTokens`)
 *     plus an interactive-element sweep.
 *
 * The old `:has-text`-only precondition is gone: a plain CSS miss used to get
 * an empty list, which is the majority of real misses.
 *
 * Never throws — a blocked eval, a dead tab or a malformed selector all yield
 * `[]` and the caller prints the bare "Element not found" line.
 *
 * `sessionId` is unused here in Task 3; Task 4 consumes it to mint ephemeral
 * handles onto the ranked list.
 */
export declare function findAlternativeSelectors(evalFn: EvalFn, selector: string, sessionId?: string): Promise<AltCandidate[]>;
/**
 * Resolve a selector to its element's viewport-center coordinates.
 * On miss, throws an Error whose message carries the ranked candidate list.
 */
export declare function getElementCenter(evalFn: EvalFn, selector: string, sessionId?: string): Promise<{
    x: number;
    y: number;
}>;
//# sourceMappingURL=element-resolver.d.ts.map