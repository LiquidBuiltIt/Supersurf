"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const frames_1 = require("../lib/frames");
(0, registry_1.registerAction)({
    name: 'scroll_to',
    async run(ctx, action) {
        if (action.selector) {
            const selectorExpr = ctx.getSelectorExpression(action.selector);
            const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
            if (!match)
                throw new Error(`Element not found: ${action.selector}`);
            const expr = `
        (() => {
          const el = ${selectorExpr};
          if (!el) return { scrolled: false };
          el.scrollTo(${action.x || 0}, ${action.y || 0});
          return { scrolled: true };
        })()
      `;
            const r = await (0, frames_1.evalInFrameOrTop)(ctx, expr, match.contextId);
            if (!r?.scrolled)
                throw new Error(`Failed to scroll ${action.selector}`);
            return `Scrolled ${action.selector} to (${action.x || 0}, ${action.y || 0})`;
        }
        await ctx.eval(`window.scrollTo(${action.x || 0}, ${action.y || 0})`);
        return `Scrolled window to (${action.x || 0}, ${action.y || 0})`;
    },
});
(0, registry_1.registerAction)({
    name: 'scroll_by',
    async run(ctx, action) {
        if (action.selector) {
            const selectorExpr = ctx.getSelectorExpression(action.selector);
            const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
            if (!match)
                throw new Error(`Element not found: ${action.selector}`);
            const expr = `
        (() => {
          const el = ${selectorExpr};
          if (!el) return { scrolled: false };
          el.scrollBy(${action.x || 0}, ${action.y || 0});
          return { scrolled: true };
        })()
      `;
            const r = await (0, frames_1.evalInFrameOrTop)(ctx, expr, match.contextId);
            if (!r?.scrolled)
                throw new Error(`Failed to scroll ${action.selector}`);
            return `Scrolled ${action.selector} by (${action.x || 0}, ${action.y || 0})`;
        }
        await ctx.eval(`window.scrollBy(${action.x || 0}, ${action.y || 0})`);
        return `Scrolled window by (${action.x || 0}, ${action.y || 0})`;
    },
});
(0, registry_1.registerAction)({
    name: 'scroll_into_view',
    async run(ctx, action) {
        const selectorExpr = ctx.getSelectorExpression(action.selector);
        const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
        if (!match)
            throw new Error(`Element not found: ${action.selector}`);
        const expr = `
      (() => {
        const el = ${selectorExpr};
        if (!el) return { scrolled: false };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { scrolled: true };
      })()
    `;
        const r = await (0, frames_1.evalInFrameOrTop)(ctx, expr, match.contextId);
        if (!r?.scrolled)
            throw new Error(`Failed to scroll ${action.selector} into view`);
        return `Scrolled ${action.selector} into view`;
    },
});
//# sourceMappingURL=scroll.js.map