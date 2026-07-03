"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const helpers_1 = require("./helpers");
const index_1 = require("../../experimental/index");
(0, registry_1.registerAction)({
    name: 'mouse_click',
    async run(ctx, action) {
        const clickTimestamp = Date.now();
        const button = action.button || 'left';
        const clickCount = action.clickCount || 1;
        await (0, helpers_1.moveCursorTo)(ctx, action.x, action.y, '_default');
        await ctx.cdp('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: action.x, y: action.y, button, clickCount, buttons: 1,
        });
        await ctx.sleep(78 + Math.floor(Math.random() * 64));
        await ctx.cdp('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: action.x, y: action.y, button, clickCount,
        });
        await ctx.eval(`(() => {
      const el = document.elementFromPoint(${action.x}, ${action.y});
      if (el && (el.closest('a[href]') || el.onclick)) el.click();
    })()`).catch(() => { });
        if (index_1.experimentRegistry.isEnabled('smart_waiting')) {
            try {
                await ctx.ext.sendCmd('waitForReady', { timeout: 3000, stabilityMs: 300, tabId: ctx.tabId });
            }
            catch { /* non-blocking */ }
        }
        const spawned = await (0, helpers_1.detectSpawnedTabs)(ctx, clickTimestamp);
        if (spawned)
            return `Clicked at (${action.x}, ${action.y})\n${spawned}`;
        return `Clicked at (${action.x}, ${action.y})`;
    },
});
//# sourceMappingURL=mouse-click.js.map