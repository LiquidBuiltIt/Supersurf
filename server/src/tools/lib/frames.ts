import type { ToolContext } from './types';

/** DFS-collect every child frame's id from a `Page.getFrameTree` root (top frame excluded). */
function collectChildFrameIds(root: any): string[] {
  const frameIds: string[] = [];
  const walk = (node: any, isRoot: boolean) => {
    if (!node?.frame?.id) return;
    if (!isRoot) frameIds.push(node.frame.id);
    for (const child of node.childFrames || []) walk(child, false);
  };
  walk(root, true);
  return frameIds;
}

/**
 * Create an isolated world in every child frame and return their execution
 * context ids. Used by heal/score passes that must evaluate in each frame
 * regardless of whether a selector matches there. Skips frames whose isolated
 * world can't be created.
 */
export async function getChildFrameContexts(
  ctx: ToolContext
): Promise<Array<{ frameId: string; contextId: number }>> {
  let tree: any;
  try {
    tree = await ctx.cdp('Page.getFrameTree', {});
  } catch {
    return [];
  }
  const root = tree?.frameTree;
  if (!root) return [];

  const out: Array<{ frameId: string; contextId: number }> = [];
  for (const frameId of collectChildFrameIds(root)) {
    try {
      const world = await ctx.cdp('Page.createIsolatedWorld', {
        frameId,
        worldName: 'supersurf_iframe',
        grantUniveralAccess: false,
      });
      if (world?.executionContextId != null) out.push({ frameId, contextId: world.executionContextId });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * DFS-walk the frame tree and evaluate `selectorExpr` in each child frame's
 * isolated world. Returns the first frame where the expression yields a
 * non-null `objectId`, along with that frame's execution context id so the
 * caller can re-use it for post-action read-backs.
 *
 * Isolated worlds sidestep CSP restrictions and page-installed Proxy
 * shenanigans, mirroring the extension's content-script isolation.
 */
export async function findElementInFrames(
  ctx: ToolContext,
  selectorExpr: string
): Promise<{ objectId: string; contextId: number; frameId: string } | null> {
  let tree: any;
  try {
    tree = await ctx.cdp('Page.getFrameTree', {});
  } catch {
    return null;
  }
  const root = tree?.frameTree;
  if (!root) return null;

  for (const frameId of collectChildFrameIds(root)) {
    let contextId: number;
    try {
      const world = await ctx.cdp('Page.createIsolatedWorld', {
        frameId,
        worldName: 'supersurf_iframe',
        grantUniveralAccess: false,
      });
      contextId = world.executionContextId;
    } catch {
      continue;
    }
    if (contextId == null) continue;

    try {
      const result = await ctx.cdp('Runtime.evaluate', {
        expression: selectorExpr,
        contextId,
        returnByValue: false,
      });
      const objectId = result?.result?.objectId;
      if (objectId) return { objectId, contextId, frameId };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve an element: try top frame first, then DFS child frames on miss.
 * `contextId` and `frameId` are both `null` when the element was found in
 * the top frame, otherwise they identify the child frame that owns it.
 */
export async function resolveInFrames(
  ctx: ToolContext,
  selectorExpr: string
): Promise<{ objectId: string; contextId: number | null; frameId: string | null } | null> {
  const top = await ctx.cdp('Runtime.evaluate', {
    expression: selectorExpr,
    returnByValue: false,
  });
  const topObjectId = top?.result?.objectId;
  if (topObjectId) return { objectId: topObjectId, contextId: null, frameId: null };

  const match = await findElementInFrames(ctx, selectorExpr);
  if (!match) return null;
  return match;
}

/**
 * Evaluate an expression in the given frame context, or top-frame default
 * context if `contextId` is null. Mirrors the error semantics of `ctx.eval`.
 */
export async function evalInFrameOrTop(
  ctx: ToolContext,
  expression: string,
  contextId: number | null
): Promise<any> {
  if (contextId === null) return ctx.eval(expression);

  const result = await ctx.cdp('Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    const msg = d.exception?.description || d.text || d.exception?.className || 'JavaScript execution error';
    throw new Error(msg);
  }
  return result.result?.value;
}

/**
 * Walk up the frame tree from `frameId`, accumulating each ancestor iframe's
 * top-left offset, to translate iframe-local coordinates into top-frame
 * viewport coordinates.
 *
 * `DOM.getBoxModel` and `getBoundingClientRect` return **iframe-local**
 * coordinates for nodes inside iframes (verified in
 * docs/research/2026-04-19-dom-getboxmodel-iframe-coords.md) — same approach
 * Playwright and Puppeteer use. Returns null if any ancestor iframe's owner
 * node can't be resolved.
 */
async function accumulateFrameOffset(
  ctx: ToolContext,
  frameId: string,
  contextId: number
): Promise<{ offsetX: number; offsetY: number } | null> {
  const tree = await ctx.cdp('Page.getFrameTree', {});
  const parentMap = new Map<string, string>();
  const walkTree = (node: any, parentId: string | null) => {
    const fid = node?.frame?.id;
    if (!fid) return;
    if (parentId) parentMap.set(fid, parentId);
    for (const child of node.childFrames || []) walkTree(child, fid);
  };
  walkTree(tree.frameTree, null);

  const contextCache = new Map<string, number>();
  contextCache.set(frameId, contextId);
  let offsetX = 0, offsetY = 0;
  let current = frameId;
  while (parentMap.has(current)) {
    const parent = parentMap.get(current)!;
    // Parent's execution context: undefined (default/top-frame) if parent is root,
    // otherwise an isolated world (create and cache).
    let parentCtxId: number | undefined;
    if (parentMap.has(parent)) {
      if (!contextCache.has(parent)) {
        const w = await ctx.cdp('Page.createIsolatedWorld', {
          frameId: parent,
          worldName: 'supersurf_iframe',
          grantUniveralAccess: false,
        });
        contextCache.set(parent, w.executionContextId);
      }
      parentCtxId = contextCache.get(parent)!;
    } else {
      parentCtxId = undefined; // top-frame default context
    }

    const owner = await ctx.cdp('DOM.getFrameOwner', { frameId: current });
    const resolved = await ctx.cdp('DOM.resolveNode', {
      backendNodeId: owner.backendNodeId,
      executionContextId: parentCtxId,
    });
    const iframeObjId = resolved.object?.objectId;
    if (!iframeObjId) return null;

    const iframeRect = await ctx.cdp('Runtime.callFunctionOn', {
      objectId: iframeObjId,
      functionDeclaration: 'function() { const r = this.getBoundingClientRect(); return { left: r.left, top: r.top }; }',
      returnByValue: true,
    });
    const or = iframeRect.result?.value;
    if (!or) return null;
    offsetX += or.left;
    offsetY += or.top;
    current = parent;
  }
  return { offsetX, offsetY };
}

/**
 * Last-ditch heal when a selector matches no frame: score the stored
 * fingerprint against each child frame's DOM (via the experiment hook) and
 * return the highest-scoring gate-passing hit, translated to top-frame
 * coordinates. Returns null when the experiment is off, no hook is wired, or no
 * frame yields a gate-passing hit.
 */
async function healInFrames(
  ctx: ToolContext,
  selector: string
): Promise<{ x: number; y: number; contextId: number } | null> {
  if (!ctx.healFingerprintInContext) return null;
  let best: { frameId: string; contextId: number; cx: number; cy: number; score: number } | null = null;
  for (const { frameId, contextId } of await getChildFrameContexts(ctx)) {
    const hit = await ctx.healFingerprintInContext(contextId, selector);
    if (hit && (!best || hit.score > best.score)) {
      best = { frameId, contextId, cx: hit.cx, cy: hit.cy, score: hit.score };
    }
  }
  if (!best) return null;
  const offset = await accumulateFrameOffset(ctx, best.frameId, best.contextId);
  if (!offset) return null;
  return {
    x: Math.round(best.cx + offset.offsetX),
    y: Math.round(best.cy + offset.offsetY),
    contextId: best.contextId,
  };
}

/**
 * Resolve top-frame viewport coordinates for an element, whether it lives in
 * the top frame or a child frame. Preserves `ctx.getElementCenter`'s
 * "Did you mean?" hints on top-frame happy path; only falls back to iframe
 * resolution when the top-frame lookup actually fails. When even the iframe
 * selector walk misses, a fingerprint heal across child frames is attempted
 * before the original error is re-thrown.
 */
export async function getCenterInFrame(
  ctx: ToolContext,
  selector: string,
  meta?: import('../../experimental/fingerprinting/handle-meta').HandleMeta,
): Promise<{ x: number; y: number; contextId: number | null }> {
  try {
    const { x, y } = await ctx.getElementCenter(selector, meta);
    return { x, y, contextId: null };
  } catch (topFrameErr) {
    const expr = ctx.getSelectorExpression(selector);
    const match = await findElementInFrames(ctx, expr);
    if (!match) {
      // Selector matched no frame. Try a fingerprint heal across child frames.
      const healed = await healInFrames(ctx, selector);
      if (healed) return healed;
      throw topFrameErr;
    }

    // Read the element's iframe-local rect in its frame context.
    const rectEval = await ctx.cdp('Runtime.evaluate', {
      expression: `
        (() => {
          const el = ${expr};
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        })()
      `,
      contextId: match.contextId,
      returnByValue: true,
    });
    const rect = rectEval.result?.value;
    if (!rect) throw topFrameErr;

    const offset = await accumulateFrameOffset(ctx, match.frameId, match.contextId);
    if (!offset) throw topFrameErr;

    const x = Math.round(rect.left + offset.offsetX + rect.width / 2);
    const y = Math.round(rect.top + offset.offsetY + rect.height / 2);
    // Iframe-nested elements bypass the top-frame capture wrapper (ctx.getElementCenter),
    // so fingerprint capture is fired here, bound to the child frame's execution context.
    ctx.captureFingerprintInContext?.(match.contextId, selector, meta);
    return { x, y, contextId: match.contextId };
  }
}
