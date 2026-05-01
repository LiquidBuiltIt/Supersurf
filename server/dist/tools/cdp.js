"use strict";
// server/src/tools/cdp.ts
//
// CDP/eval primitives. Pure functions over an IExtensionTransport — no class
// state, no implicit `this`. Used by ToolContext and the element resolver.
Object.defineProperty(exports, "__esModule", { value: true });
exports.cdp = cdp;
exports.evalExpr = evalExpr;
/** Send a CDP command through the extension's `forwardCDPCommand` handler. */
async function cdp(ext, method, params = {}) {
    return await ext.sendCmd('forwardCDPCommand', { method, params });
}
/**
 * Evaluate a JS expression in the page context via `Runtime.evaluate`.
 * Throws with the page-side exception message when evaluation fails.
 */
async function evalExpr(ext, expression, awaitPromise = true) {
    const result = await cdp(ext, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
    });
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