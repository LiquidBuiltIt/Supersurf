"use strict";
/**
 * Interaction tool handlers — click, type, scroll, hover, etc.
 *
 * Handles the `browser_interact` tool which accepts an ordered array of
 * actions and executes them sequentially. Integrates with two experimental
 * features: page_diffing (captures DOM before/after and returns a diff)
 * and mouse_humanization (generates Bezier-curve mouse paths).
 *
 * All mouse interactions go through CDP `Input.dispatch*` events with
 * realistic timing based on the Balabit Mouse Dynamics dataset.
 *
 * @module tools/interaction
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.onInteract = onInteract;
const index_1 = require("../../experimental/index");
const registry_1 = require("./registry");
// Side-effect: each module calls registerAction() at load time.
require("./mouse-move");
require("./mouse-click");
require("./press-key");
require("./clear");
require("./scroll");
require("./select-option");
require("./force-pseudo-state");
require("./hover");
require("./wait");
require("./click");
require("./type");
require("./select-custom");
require("./file-upload");
/**
 * Execute a sequence of page interactions (click, type, hover, scroll, etc.).
 *
 * Optionally captures DOM state before/after for page diffing, and returns
 * per-action success/failure results. The `onError` arg controls whether
 * the sequence stops on first failure or continues.
 *
 * @param ctx - Tool context with CDP/eval/extension access
 * @param args - `{ actions: Action[], onError?: 'stop'|'ignore', screenshot?: boolean }`
 * @param options - `{ rawResult?: boolean }`
 */
async function onInteract(ctx, args, options) {
    const actions = args.actions;
    const onError = args.onError || 'stop';
    const results = [];
    // === EXPERIMENTAL: page diffing — capture before state ===
    let beforeState = null;
    const isOnlyScrollActions = actions.every((a) => ['scroll_to', 'scroll_by', 'scroll_into_view'].includes(a.type));
    const captureMode = isOnlyScrollActions ? 'viewport' : 'document';
    if (index_1.experimentRegistry.isEnabled('page_diffing')) {
        try {
            beforeState = await ctx.ext.sendCmd('capturePageState', { mode: captureMode, tabId: ctx.tabId });
        }
        catch { /* silently skip — extension may not support it yet */ }
    }
    for (const action of actions) {
        try {
            const msg = await (0, registry_1.executeAction)(ctx, action);
            // Handlers may return a message starting with `⚠ ` to signal a soft
            // unverified result (mutation ran but post-action read-back didn't
            // confirm). Strip the marker and use it as the line prefix instead of ✓.
            const isWarn = typeof msg === 'string' && msg.startsWith('⚠ ');
            const body = isWarn ? msg.slice(2) : msg;
            results.push(`${isWarn ? '⚠' : '✓'} ${action.type}: ${body}`);
        }
        catch (error) {
            results.push(`✗ ${action.type}: ${error.message}`);
            if (onError === 'stop')
                break;
        }
    }
    // === EXPERIMENTAL: page diffing — capture after state and diff ===
    let diffSection = '';
    if (beforeState) {
        try {
            // Let smooth scroll animations settle before capturing viewport
            if (isOnlyScrollActions)
                await ctx.sleep(350);
            const afterState = await ctx.ext.sendCmd('capturePageState', { mode: captureMode, tabId: ctx.tabId });
            const confidence = (0, index_1.calculateConfidence)(afterState);
            if (confidence >= 0.5) {
                diffSection = (0, index_1.formatDiffSection)((0, index_1.diffSnapshots)(beforeState, afterState), confidence, afterState, captureMode);
            }
            else {
                diffSection = `\n\n---\n**Page diff:** confidence below threshold (${Math.round(confidence * 100)}%) — full re-read recommended`;
            }
        }
        catch { /* silently skip */ }
    }
    if (options.rawResult) {
        return { success: !results.some(r => r.startsWith('✗')), actions: results };
    }
    return {
        content: [{ type: 'text', text: results.join('\n') + diffSection }],
        isError: results.some(r => r.startsWith('✗')),
    };
}
//# sourceMappingURL=index.js.map