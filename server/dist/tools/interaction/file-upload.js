"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const frames_1 = require("../lib/frames");
(0, registry_1.registerAction)({
    name: 'file_upload',
    async run(ctx, action) {
        const selectorExpr = ctx.getSelectorExpression(action.selector);
        const meta = { name: action.name, purpose: action.purpose };
        const verificationExpr = `
      (() => {
        const el = ${ctx.getSelectorExpression(action.selector)};
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
        if (objectId && action.selector) {
            ctx.captureFingerprintInContext?.(null, action.selector, meta); // null contextId => top frame
        }
        // Step 2: If top frame has no match, walk child frames in DFS order.
        if (!objectId) {
            const match = await (0, frames_1.findElementInFrames)(ctx, selectorExpr);
            if (match) {
                objectId = match.objectId;
                frameContextId = match.contextId;
                if (action.selector) {
                    ctx.captureFingerprintInContext?.(match.contextId, action.selector, meta);
                }
            }
            else if (action.selector) {
                // Step 3: no frame matched the selector at all — try a fingerprint heal.
                const healed = await (0, frames_1.healSelectorAcrossFrames)(ctx, action.selector);
                if (healed) {
                    objectId = healed.objectId;
                    frameContextId = healed.contextId;
                }
            }
            if (!objectId) {
                throw new Error(`Element not found in any frame: ${action.selector}`);
            }
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