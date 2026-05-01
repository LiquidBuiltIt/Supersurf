"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KEY_MAP = void 0;
exports.getViewportSize = getViewportSize;
exports.moveCursorTo = moveCursorTo;
exports.detectSpawnedTabs = detectSpawnedTabs;
const index_1 = require("../../experimental/index");
const index_2 = require("../../experimental/mouse-humanization/index");
const logger_1 = require("../../logger");
const log = (0, logger_1.createLog)('[Interact]');
async function getViewportSize(ctx) {
    return await ctx.ext.sendCmd('getViewportDimensions', {});
}
async function moveCursorTo(ctx, x, y, sessionId) {
    if (index_1.experimentRegistry.isEnabled('mouse_humanization')) {
        try {
            const viewport = await getViewportSize(ctx);
            const waypoints = (0, index_2.generateMovement)(sessionId, x, y, viewport);
            log(`Humanized move → (${x},${y}) via ${waypoints.length} waypoints`);
            await ctx.ext.sendCmd('humanizedMouseMove', { waypoints });
            return;
        }
        catch (e) {
            log(`Humanization failed, falling back to teleport:`, e.message);
        }
    }
    log(`Teleport → (${x},${y})`);
    await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}
async function detectSpawnedTabs(ctx, since) {
    try {
        await ctx.sleep(300);
        const result = await ctx.ext.sendCmd('drainSpawnedTabs', { since }, 3000);
        if (result?.tabs?.length > 0) {
            const lines = result.tabs.map((t) => `  → Tab #${t.index}: ${t.url || 'about:blank'}${t.title ? ` ("${t.title}")` : ''}`);
            return `New tab(s) opened:\n${lines.join('\n')}\nUse browser_tabs action='attach' index=N to switch.`;
        }
    }
    catch { /* non-blocking */ }
    return null;
}
exports.KEY_MAP = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27, text: '' },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, text: '' },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46, text: '' },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, text: '' },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, text: '' },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, text: '' },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, text: '' },
    Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    Home: { key: 'Home', code: 'Home', keyCode: 36, text: '' },
    End: { key: 'End', code: 'End', keyCode: 35, text: '' },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33, text: '' },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34, text: '' },
};
//# sourceMappingURL=helpers.js.map