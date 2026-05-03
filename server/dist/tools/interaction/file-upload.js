"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const frames_1 = require("../lib/frames");
(0, registry_1.registerAction)({
    name: 'file_upload',
    async run(ctx, action) {
        const selectorExpr = `document.querySelector(${JSON.stringify(action.selector)})`;
        const verificationExpr = `
      (() => {
        const el = document.querySelector(${JSON.stringify(action.selector)});
        if (!el) return { verified: false, count: 0 };
        const count = el.files ? el.files.length : 0;
        return { verified: count === ${action.files.length}, count };
      })()
    `;
        // Step 1: Try top frame first (unchanged happy path).
        const evalResult = await ctx.cdp('Runtime.evaluate', {
            expression: selectorExpr,
            returnByValue: false,
        });
        let objectId = evalResult.result?.objectId;
        let frameContextId = null;
        // Step 2: If top frame has no match, walk child frames in DFS order.
        if (!objectId) {
            const match = await (0, frames_1.findElementInFrames)(ctx, selectorExpr);
            if (!match) {
                throw new Error(`Element not found in any frame: ${action.selector}`);
            }
            objectId = match.objectId;
            frameContextId = match.contextId;
        }
        const nodeResult = await ctx.cdp('DOM.describeNode', { objectId });
        await ctx.cdp('DOM.setFileInputFiles', {
            files: action.files,
            backendNodeId: nodeResult.node.backendNodeId,
        });
        // Read-back must run in the SAME frame context as the input.
        let verification;
        if (frameContextId !== null) {
            const r = await ctx.cdp('Runtime.evaluate', {
                expression: verificationExpr,
                contextId: frameContextId,
                returnByValue: true,
            });
            verification = r.result?.value;
        }
        else {
            verification = await ctx.eval(verificationExpr);
        }
        const expectedCount = action.files.length;
        if (verification?.verified) {
            return `Uploaded ${expectedCount} file(s) to ${action.selector}`;
        }
        return `⚠ Uploaded ${expectedCount} file(s) to ${action.selector} (unverified — input reports ${verification?.count ?? 0} file(s) after upload; the page may not have observed the change)`;
    },
});
//# sourceMappingURL=file-upload.js.map