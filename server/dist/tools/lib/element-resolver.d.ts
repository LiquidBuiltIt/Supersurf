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
/**
 * Search the page for elements whose direct text content includes the
 * `:has-text(...)` substring of the failing selector. Returns up to
 * three visible candidates and two hidden, each with a guess at a
 * usable selector. Returns `[]` when the input doesn't have a
 * `:has-text(...)` suffix or when the page-eval throws.
 */
export declare function findAlternativeSelectors(evalFn: EvalFn, selector: string): Promise<any[]>;
/**
 * Resolve a selector to its element's viewport-center coordinates.
 * On miss, throws an Error whose message includes "Did you mean?"
 * suggestions when the selector contains `:has-text(...)`.
 */
export declare function getElementCenter(evalFn: EvalFn, selector: string): Promise<{
    x: number;
    y: number;
}>;
//# sourceMappingURL=element-resolver.d.ts.map