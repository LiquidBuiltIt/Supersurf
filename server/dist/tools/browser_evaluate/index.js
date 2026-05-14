"use strict";
/**
 * `browser_evaluate` tool handler — runs JS in the page context with three-layer
 * `secure_eval` defense.
 *
 * Layer 1 (AST static analysis) and Layer 3 (page-context Proxy wrapper) live
 * in `./secure-eval`. Layer 2 (Service Worker membrane) lives extension-side
 * at `extension/src/security/secure-eval/`.
 *
 * `secure_eval` is on by default. Opt out by setting `security.secure_eval: false`
 * in `~/.supersurf/config.json` (and restarting the daemon), via the
 * `--disable-secure-eval` server CLI flag, or `SUPERSURF_DISABLE_SECURE_EVAL=1`.
 *
 * @module tools/browser_evaluate/index
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.onEvaluate = onEvaluate;
const secure_eval_1 = require("./secure-eval");
/**
 * Evaluate JavaScript in the page context.
 *
 * Three-layer defense pipeline (when `secure_eval` is enabled):
 * 1. **Static AST analysis** (~1ms): Blocks known dangerous patterns
 * 2. **Service Worker Proxy membrane** (~10–20ms): Extension-side validation
 * 3. **Page-context Proxy wrapper**: Runtime API access trapping
 *
 * @param args - `{ purpose: string, function?: string, expression?: string }`
 */
async function onEvaluate(ctx, args, options) {
    const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
    if (!purpose) {
        return ctx.error('`browser_evaluate` requires a `purpose` parameter explaining why evaluate is needed ' +
            'instead of a dedicated tool (browser_lookup, browser_extract_content, browser_interact, ' +
            'browser_fill_form, browser_navigate, browser_get_element_styles).', options);
    }
    // Normalize function form to an IIFE expression so it actually executes.
    // Without this wrap, an arrow function like `() => 42` parses as a bare
    // function literal whose return value is discarded, yielding undefined.
    const expression = args.function ? `(${args.function})()` : args.expression;
    const code = expression;
    const secureEvalEnabled = ctx.config?.get().security.secure_eval ?? true;
    if (code && secureEvalEnabled) {
        // Layer 1: Static AST analysis (~1ms)
        const analysis = (0, secure_eval_1.analyzeCode)(code);
        if (!analysis.safe) {
            return ctx.error(`Code blocked by \`secure_eval\`.\n\n` +
                `**Reason:** ${analysis.reason}\n\n` +
                `\`browser_evaluate\` is for read-only computation only. ` +
                `For network calls, storage access, navigation, form filling, or DOM mutation, use the dedicated MCP tools ` +
                `(browser_navigate, browser_fill_form, browser_interact, browser_storage, browser_network_requests). ` +
                `If you genuinely need this primitive, set \`security.secure_eval: false\` in \`~/.supersurf/config.json\` (and restart the daemon), or \`SUPERSURF_DISABLE_SECURE_EVAL=1\` in the server env.`, options);
        }
        // Layer 2: SW Proxy membrane (~10-20ms)
        try {
            const validation = await ctx.ext.sendCmd('validateEval', { code });
            if (validation && validation.safe === false) {
                return ctx.error(`Code blocked by \`secure_eval\` (membrane).\n\n` +
                    `**Reason:** ${validation.reason}\n\n` +
                    `\`browser_evaluate\` is for read-only computation only. Use a dedicated MCP tool, ` +
                    `or set \`security.secure_eval: false\` in \`~/.supersurf/config.json\` (and restart the daemon).`, options);
            }
        }
        catch {
            // Extension doesn't support validateEval — Layer 1+3 still cover
        }
        // Layer 3: Page-context Proxy wrapper
        const wrapped = (0, secure_eval_1.wrapWithPageProxy)(code);
        try {
            const result = await ctx.ext.sendCmd('evaluate', {
                expression: wrapped,
                prewrapped: true,
            });
            if (options.rawResult)
                return result;
            const text = result === undefined ? 'undefined'
                : result === null ? 'null'
                    : typeof result === 'string' ? result
                        : JSON.stringify(result, null, 2);
            return { content: [{ type: 'text', text }] };
        }
        catch (err) {
            const message = err?.message || '';
            if (message.includes('[secure_eval]')) {
                return ctx.error(`Code blocked by \`secure_eval\` (page proxy).\n\n` +
                    `**Reason:** ${message}\n\n` +
                    `\`browser_evaluate\` is for read-only computation only. Use a dedicated MCP tool, ` +
                    `or set \`security.secure_eval: false\` in \`~/.supersurf/config.json\` (and restart the daemon).`, options);
            }
            throw err;
        }
    }
    const result = await ctx.ext.sendCmd('evaluate', {
        expression,
    });
    if (options.rawResult)
        return result;
    const text = result === undefined ? 'undefined'
        : result === null ? 'null'
            : typeof result === 'string' ? result
                : JSON.stringify(result, null, 2);
    return {
        content: [{ type: 'text', text }],
    };
}
//# sourceMappingURL=index.js.map