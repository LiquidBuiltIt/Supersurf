"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const frames_1 = require("../lib/frames");
const handle_resolve_1 = require("../../experimental/fingerprinting/handle-resolve");
const element_resolver_1 = require("../lib/element-resolver");
(0, registry_1.registerAction)({
    name: 'wait',
    async run(ctx, action) {
        const timeout = action.timeout || 30000;
        if (action.selector) {
            const selectorExpr = ctx.getSelectorExpression(action.selector);
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const match = await (0, frames_1.resolveInFrames)(ctx, selectorExpr);
                if (match)
                    return `Element appeared: ${action.selector}`;
                await ctx.sleep(100);
            }
            const alts = await ctx.findAlternativeSelectors(action.selector).catch(() => []);
            const block = (0, element_resolver_1.renderAlternatives)(alts);
            throw new Error(`Timeout waiting for element: ${action.selector}${(0, handle_resolve_1.handleMissHint)(action.selector)}` +
                (block ? `\n\n${block}` : ''));
        }
        await ctx.sleep(timeout);
        return `Waited ${timeout}ms`;
    },
});
//# sourceMappingURL=wait.js.map