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

  const frameIds: string[] = [];
  const walk = (node: any, isRoot: boolean) => {
    if (!node?.frame?.id) return;
    if (!isRoot) frameIds.push(node.frame.id);
    const children = node.childFrames || [];
    for (const child of children) walk(child, false);
  };
  walk(root, true);

  for (const frameId of frameIds) {
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
export async function getCenterInFrame(
  ctx: ToolContext,
  selector: string
): Promise<{ x: number; y: number; contextId: number | null }> {
  try {
    const { x, y } = await ctx.getElementCenter(selector);
    return { x, y, contextId: null };
  } catch (topFrameErr) {
    const expr = ctx.getSelectorExpression(selector);
    const match = await findElementInFrames(ctx, expr);
    if (!match) throw topFrameErr;

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

    // Build parent map from the frame tree.
    const tree = await ctx.cdp('Page.getFrameTree', {});
    const parentMap = new Map<string, string>();
    const walkTree = (node: any, parentId: string | null) => {
      const fid = node?.frame?.id;
      if (!fid) return;
      if (parentId) parentMap.set(fid, parentId);
      for (const child of node.childFrames || []) walkTree(child, fid);
    };
    walkTree(tree.frameTree, null);

    // Walk up from target frame, accumulating iframe offsets.
    const contextCache = new Map<string, number>();
    contextCache.set(match.frameId, match.contextId);
    let offsetX = 0, offsetY = 0;
    let current = match.frameId;
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
      if (!iframeObjId) throw topFrameErr;

      const iframeRect = await ctx.cdp('Runtime.callFunctionOn', {
        objectId: iframeObjId,
        functionDeclaration: 'function() { const r = this.getBoundingClientRect(); return { left: r.left, top: r.top }; }',
        returnByValue: true,
      });
      const or = iframeRect.result?.value;
      if (!or) throw topFrameErr;
      offsetX += or.left;
      offsetY += or.top;
      current = parent;
    }

    const x = Math.round(rect.left + offsetX + rect.width / 2);
    const y = Math.round(rect.top + offsetY + rect.height / 2);
    return { x, y, contextId: match.contextId };
  }
}
