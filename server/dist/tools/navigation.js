"use strict";
/**
 * Navigation and tab management tool handlers.
 *
 * Implements `browser_tabs` (list/new/attach/close) and `browser_navigate`
 * (url/back/forward/reload). Tab operations sync metadata (attached tab,
 * stealth mode) with the ConnectionManager. Navigation integrates with
 * the `smart_waiting` experiment for adaptive DOM-stability waits instead
 * of fixed 1500ms delays.
 *
 * @module tools/navigation
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.onBrowserTabs = onBrowserTabs;
exports.onNavigate = onNavigate;
const index_1 = require("../experimental/index");
/**
 * Manage browser tabs: list, create, attach (with optional stealth), or close.
 * Updates ConnectionManager metadata on attach/close to keep status headers accurate.
 *
 * @param args - `{ action: 'list'|'new'|'attach'|'close', url?, index?, activate?, stealth? }`
 */
async function onBrowserTabs(ctx, args, options) {
    const action = args.action;
    let result;
    switch (action) {
        case 'list':
            result = await ctx.ext.sendCmd('getTabs', {});
            break;
        case 'new':
            result = await ctx.ext.sendCmd('createTab', {
                url: args.url,
                activate: args.activate !== false,
            });
            break;
        case 'attach':
            result = await ctx.ext.sendCmd('selectTab', {
                index: args.index,
                stealth: args.stealth,
            });
            break;
        case 'close':
            result = await ctx.ext.sendCmd('closeTab', args.index);
            break;
        default:
            return ctx.error(`Unknown tab action: ${action}`, options);
    }
    if (result && ctx.connectionManager) {
        if (action === 'new' || action === 'attach') {
            ctx.connectionManager.setAttachedTab(result);
            if (args.stealth)
                ctx.connectionManager.setStealthMode(true);
        }
        else if (action === 'close') {
            ctx.connectionManager.clearAttachedTab();
        }
    }
    return ctx.formatResult('browser_tabs', result, options);
}
/**
 * Navigate the attached tab: go to URL, back, forward, or reload.
 *
 * After navigation, waits for the page to be ready — either via the
 * `smart_waiting` experiment (DOM stability + network idle) or a fixed
 * 1500ms delay as fallback. Pre-captured screenshot data from the
 * extension is forwarded for inline screenshot attachment.
 *
 * @param args - `{ action: 'url'|'back'|'forward'|'reload', url?, screenshot? }`
 */
async function onNavigate(ctx, args, options) {
    const action = args.action;
    let result;
    switch (action) {
        case 'url': {
            const smartWait = index_1.experimentRegistry.isEnabled('smart_waiting');
            result = await ctx.ext.sendCmd('navigate', {
                action: 'url',
                url: args.url,
                screenshot: !!args.screenshot,
                smartWait,
                smartWaitStabilityMs: 500,
            });
            if (ctx.connectionManager?.attachedTab) {
                ctx.connectionManager.attachedTab.url = args.url;
            }
            // If extension didn't handle waiting (no screenshot path), wait server-side
            if (!args.screenshot) {
                if (smartWait) {
                    try {
                        await ctx.ext.sendCmd('waitForReady', { timeout: 10000, stabilityMs: 500 });
                    }
                    catch { /* fall through — page may already be ready */ }
                }
                else {
                    await ctx.sleep(1500);
                }
            }
            break;
        }
        case 'back':
            await ctx.eval('window.history.back()');
            // === EXPERIMENTAL: smart waiting ===
            if (index_1.experimentRegistry.isEnabled('smart_waiting')) {
                try {
                    await ctx.ext.sendCmd('waitForReady', { timeout: 10000, stabilityMs: 500 });
                }
                catch {
                    await ctx.sleep(1500);
                }
            }
            else {
                await ctx.sleep(1500);
            }
            result = { success: true, action: 'back', url: await ctx.eval('window.location.href') };
            break;
        case 'forward':
            await ctx.eval('window.history.forward()');
            // === EXPERIMENTAL: smart waiting ===
            if (index_1.experimentRegistry.isEnabled('smart_waiting')) {
                try {
                    await ctx.ext.sendCmd('waitForReady', { timeout: 10000, stabilityMs: 500 });
                }
                catch {
                    await ctx.sleep(1500);
                }
            }
            else {
                await ctx.sleep(1500);
            }
            result = { success: true, action: 'forward', url: await ctx.eval('window.location.href') };
            break;
        case 'reload':
            result = await ctx.ext.sendCmd('navigate', { action: 'reload' });
            // === EXPERIMENTAL: smart waiting ===
            if (index_1.experimentRegistry.isEnabled('smart_waiting')) {
                try {
                    await ctx.ext.sendCmd('waitForReady', { timeout: 10000, stabilityMs: 500 });
                }
                catch { /* fall through */ }
            }
            else {
                await ctx.sleep(1500);
            }
            break;
        default:
            return ctx.error(`Unknown navigate action: ${action}`, options);
    }
    // Extract screenshot data before formatResult serializes — prevents
    // base64 blob from being dumped into a JSON text block
    const screenshotData = result?.screenshotData;
    const screenshotMimeType = result?.screenshotMimeType;
    if (result) {
        delete result.screenshotData;
        delete result.screenshotMimeType;
    }
    const formatted = ctx.formatResult('browser_navigate', result, options);
    // Forward pre-captured screenshot data for maybeAppendScreenshot
    if (screenshotData && formatted && !options.rawResult) {
        formatted._screenshotData = screenshotData;
        formatted._screenshotMimeType = screenshotMimeType;
    }
    return formatted;
}
//# sourceMappingURL=navigation.js.map