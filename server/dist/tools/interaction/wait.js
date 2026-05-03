"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const frames_1 = require("../lib/frames");
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
            throw new Error(`Timeout waiting for element: ${action.selector}`);
        }
        await ctx.sleep(timeout);
        return `Waited ${timeout}ms`;
    },
});
//# sourceMappingURL=wait.js.map