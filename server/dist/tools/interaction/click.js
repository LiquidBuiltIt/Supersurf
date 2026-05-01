"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const frames_1 = require("../frames");
const helpers_1 = require("./helpers");
const index_1 = require("../../experimental/index");
(0, registry_1.registerAction)({
    name: 'click',
    async run(ctx, action) {
        const clickTimestamp = Date.now();
        let x, y;
        let clickContextId = null;
        if (action.selector) {
            const c = await (0, frames_1.getCenterInFrame)(ctx, action.selector);
            x = c.x;
            y = c.y;
            clickContextId = c.contextId;
        }
        else if (action.x !== undefined && action.y !== undefined) {
            x = action.x;
            y = action.y;
        }
        else {
            throw new Error('click requires either a selector or {x, y}');
        }
        const button = action.button || 'left';
        const clickCount = action.clickCount || 1;
        await (0, helpers_1.moveCursorTo)(ctx, x, y, '_default');
        await ctx.cdp('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button, clickCount, buttons: 1,
        });
        await ctx.sleep(78 + Math.floor(Math.random() * 64));
        await ctx.cdp('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button, clickCount,
        });
        const domClickExpr = `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (el && (el.closest('a[href]') || el.onclick)) el.click();
    })()`;
        await (0, frames_1.evalInFrameOrTop)(ctx, domClickExpr, clickContextId).catch(() => { });
        if (index_1.experimentRegistry.isEnabled('smart_waiting')) {
            try {
                await ctx.ext.sendCmd('waitForReady', { timeout: 3000, stabilityMs: 300 });
            }
            catch { /* non-blocking */ }
        }
        const spawned = await (0, helpers_1.detectSpawnedTabs)(ctx, clickTimestamp);
        const target = action.selector ? `${action.selector} at (${x}, ${y})` : `(${x}, ${y})`;
        if (spawned)
            return `Clicked ${target}\n${spawned}`;
        return `Clicked ${target}`;
    },
});
//# sourceMappingURL=click.js.map