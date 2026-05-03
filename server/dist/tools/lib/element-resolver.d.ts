/** Async page evaluator signature (matches the inner closure of `evalExpr`). */
export type EvalFn = (expression: string, awaitPromise?: boolean) => Promise<any>;
/**
 * Convert a CSS selector (with optional `:has-text("...")`) into a JS
 * expression that resolves to the matching Element or null. The
 * `:has-text` form is a SuperSurf extension — the page-eval falls back
 * to scanning textContent when the selector includes it.
 */
export declare function getSelectorExpression(selector: string): string;
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