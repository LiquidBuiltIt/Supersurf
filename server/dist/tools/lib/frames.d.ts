import type { ToolContext } from './types';
/**
 * DFS-walk the frame tree and evaluate `selectorExpr` in each child frame's
 * isolated world. Returns the first frame where the expression yields a
 * non-null `objectId`, along with that frame's execution context id so the
 * caller can re-use it for post-action read-backs.
 *
 * Isolated worlds sidestep CSP restrictions and page-installed Proxy
 * shenanigans, mirroring the extension's content-script isolation.
 */
export declare function findElementInFrames(ctx: ToolContext, selectorExpr: string): Promise<{
    objectId: string;
    contextId: number;
    frameId: string;
} | null>;
/**
 * Resolve an element: try top frame first, then DFS child frames on miss.
 * `contextId` and `frameId` are both `null` when the element was found in
 * the top frame, otherwise they identify the child frame that owns it.
 */
export declare function resolveInFrames(ctx: ToolContext, selectorExpr: string): Promise<{
    objectId: string;
    contextId: number | null;
    frameId: string | null;
} | null>;
/**
 * Evaluate an expression in the given frame context, or top-frame default
 * context if `contextId` is null. Mirrors the error semantics of `ctx.eval`.
 */
export declare function evalInFrameOrTop(ctx: ToolContext, expression: string, contextId: number | null): Promise<any>;
/**
 * Resolve top-frame viewport coordinates for an element, whether it lives in
 * the top frame or a child frame. Preserves `ctx.getElementCenter`'s
 * "Did you mean?" hints on top-frame happy path; only falls back to iframe
 * resolution when the top-frame lookup actually fails.
 *
 * `DOM.getBoxModel` and `getBoundingClientRect` return **iframe-local**
 * coordinates for nodes inside iframes (verified in
 * docs/research/2026-04-19-dom-getboxmodel-iframe-coords.md). This function
 * walks up the frame tree and accumulates each ancestor iframe's top-left
 * offset to produce top-frame viewport coordinates — same approach Playwright
 * and Puppeteer use.
 */
export declare function getCenterInFrame(ctx: ToolContext, selector: string): Promise<{
    x: number;
    y: number;
    contextId: number | null;
}>;
//# sourceMappingURL=frames.d.ts.map