"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const frames_1 = require("../lib/frames");
(0, registry_1.registerAction)({
    name: 'clear',
    async run(ctx, action) {
        const selectorExpr = ctx.getSelectorExpression(action.selector);
        const meta = { name: action.name, purpose: action.purpose };
        const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr, action.selector, meta);
        if (!match)
            throw new Error(`Element not found: ${action.selector}`);
        const clearExpr = `
      (() => {
        const el = ${selectorExpr};
        if (!el) return { cleared: false };
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { cleared: true };
      })()
    `;
        const result = await (0, frames_1.evalInFrameOrTop)(ctx, clearExpr, match.contextId);
        if (!result?.cleared)
            throw new Error(`Failed to clear ${action.selector}`);
        return `Cleared ${action.selector}`;
    },
});
//# sourceMappingURL=clear.js.map