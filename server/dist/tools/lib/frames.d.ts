import type { ToolContext } from './types';
/**
 * Create an isolated world in every child frame and return their execution
 * context ids. Used by heal/score passes that must evaluate in each frame
 * regardless of whether a selector matches there. Skips frames whose isolated
 * world can't be created.
 */
export declare function getChildFrameContexts(ctx: ToolContext): Promise<Array<{
    frameId: string;
    contextId: number;
}>>;
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
 * Heal a resolveInFrames() total miss (selector matched neither the top frame
 * nor any child frame) by scoring the stored fingerprint against the top
 * frame first, then every child frame, and returning the highest-scoring
 * gate-passing hit as a resolved element handle. Unlike click/hover's
 * coordinate-only heal (`healInFrames` above), selector-resolving verbs
 * (type, select_option, fill_form fields, file_upload, …) need a live
 * element to act on, so only hits `ctx.healFingerprintInContext` could
 * re-resolve (`objectId`/`resolvedExpr` both set) are eligible. Returns
 * null when the experiment is off, no hook is wired, or no context yields
 * a resolvable hit.
 */
export declare function healSelectorAcrossFrames(ctx: ToolContext, selector: string): Promise<{
    objectId: string;
    contextId: number | null;
    frameId: string | null;
    resolvedExpr: string;
} | null>;
/**
 * Resolve an element: try top frame first, then DFS child frames on miss,
 * then (when `selector` is supplied) a fingerprint heal across every frame.
 * `contextId` and `frameId` are both `null` when the element was found (or
 * healed) in the top frame, otherwise they identify the frame that owns it.
 * `resolvedExpr` is the JS expression callers should re-evaluate to reach the
 * element: `selectorExpr` unchanged on a direct hit, or a heal-synthesized
 * expression (a re-queryable selector, or `elementFromPoint` as a last
 * resort) when the original selector had to be healed.
 */
export declare function resolveInFrames(ctx: ToolContext, selectorExpr: string, selector?: string, meta?: import('../../experimental/fingerprinting/handle-meta').HandleMeta): Promise<{
    objectId: string;
    contextId: number | null;
    frameId: string | null;
    resolvedExpr: string;
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
 * resolution when the top-frame lookup actually fails. When even the iframe
 * selector walk misses, a fingerprint heal across child frames is attempted
 * before the original error is re-thrown.
 */
export declare function getCenterInFrame(ctx: ToolContext, selector: string, meta?: import('../../experimental/fingerprinting/handle-meta').HandleMeta): Promise<{
    x: number;
    y: number;
    contextId: number | null;
}>;
//# sourceMappingURL=frames.d.ts.map