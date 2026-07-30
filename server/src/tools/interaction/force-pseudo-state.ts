import { registerAction } from './registry';
import { findElementInFrames } from '../lib/frames';

registerAction({
  name: 'force_pseudo_state',
  async run(ctx, action) {
    const pseudoStates = action.pseudoStates || [];
    // Raw-CDP site: bypasses getSelectorExpression, so translate the handle here.
    const selector = ctx.resolveSelector?.(action.selector) ?? action.selector;
    const doc = await ctx.cdp('DOM.getDocument', {});
    const topResult = await ctx.cdp('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    });
    let nodeId = topResult.nodeId;
    if (!nodeId) {
      const selectorExpr = ctx.getSelectorExpression(selector);
      const match = await findElementInFrames(ctx, selectorExpr);
      if (!match) throw new Error(`Element not found: ${action.selector}`);
      const req = await ctx.cdp('DOM.requestNode', { objectId: match.objectId });
      nodeId = req.nodeId;
    }
    if (!nodeId) throw new Error(`Element not found: ${action.selector}`);

    await ctx.cdp('CSS.forcePseudoState', {
      nodeId,
      forcedPseudoClasses: pseudoStates,
    });
    return `Forced pseudo-states [${pseudoStates.join(', ')}] on ${action.selector}`;
  },
});
