"use strict";
// server/src/tools/cdp.ts
//
// CDP/eval primitives. Pure functions over an IExtensionTransport — no class
// state, no implicit `this`. Used by ToolContext and the element resolver.
Object.defineProperty(exports, "__esModule", { value: true });
exports.cdp = cdp;
exports.evalExpr = evalExpr;
/**
 * Send a CDP command through the extension's `forwardCDPCommand` handler.
 *
 * `tabId` pins the command to a specific tab for concurrency isolation; the
 * extension resolves it via `ensureAttachedTab(tabId)` without mutating its
 * shared attached-tab global. Omit to act on the session's attached tab.
 */
async function cdp(ext, method, params = {}, tabId) {
    return await ext.sendCmd('forwardCDPCommand', { method, params, tabId });
}
/**
 * Evaluate a JS expression in the page context via `Runtime.evaluate`.
 * Throws with the page-side exception message when evaluation fails.
 * `tabId` pins evaluation to a specific tab (see `cdp`).
 */
async function evalExpr(ext, expression, awaitPromise = true, tabId) {
    const result = await cdp(ext, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
    }, tabId);
    if (result.exceptionDetails) {
        const details = result.exceptionDetails;
        const message = details.exception?.description
            || details.text
            || details.exception?.className
            || 'JavaScript execution error';
        throw new Error(message);
    }
    return result.result?.value;
}
//# sourceMappingURL=cdp.js.map