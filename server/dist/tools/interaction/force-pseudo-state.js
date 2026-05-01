"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const frames_1 = require("../frames");
(0, registry_1.registerAction)({
    name: 'force_pseudo_state',
    async run(ctx, action) {
        const pseudoStates = action.pseudoStates || [];
        const doc = await ctx.cdp('DOM.getDocument', {});
        const topResult = await ctx.cdp('DOM.querySelector', {
            nodeId: doc.root.nodeId,
            selector: action.selector,
        });
        let nodeId = topResult.nodeId;
        if (!nodeId) {
            const selectorExpr = ctx.getSelectorExpression(action.selector);
            const match = await (0, frames_1.findElementInFrames)(ctx, selectorExpr);
            if (!match)
                throw new Error(`Element not found: ${action.selector}`);
            const req = await ctx.cdp('DOM.requestNode', { objectId: match.objectId });
            nodeId = req.nodeId;
        }
        if (!nodeId)
            throw new Error(`Element not found: ${action.selector}`);
        await ctx.cdp('CSS.forcePseudoState', {
            nodeId,
            forcedPseudoClasses: pseudoStates,
        });
        return `Forced pseudo-states [${pseudoStates.join(', ')}] on ${action.selector}`;
    },
});
//# sourceMappingURL=force-pseudo-state.js.map