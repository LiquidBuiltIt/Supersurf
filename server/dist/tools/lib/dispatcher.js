"use strict";
// server/src/tools/dispatcher.ts
//
// Tool name → handler dispatch. Owns the switch, audit logging,
// CDP-conflict error rewriting, and contextual tip rendering. Pure:
// receives a ToolContext + name/args/options and returns the MCP result.
//
// BrowserBridge just builds the ToolContext and forwards to dispatchTool().
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatchTool = dispatchTool;
const logger_1 = require("../../logger");
const index_1 = require("../../experimental/index");
const tips_1 = require("../../tips");
const interaction_1 = require("../interaction");
const content_1 = require("../content");
const styles_1 = require("../styles");
const screenshot_1 = require("../screenshot");
const network_1 = require("../network");
const navigation_1 = require("../navigation");
const forms_1 = require("../forms");
const downloads_1 = require("../downloads");
const misc_1 = require("../misc");
const browser_evaluate_1 = require("../browser_evaluate");
const result_formatter_1 = require("./result-formatter");
const log = (0, logger_1.createLog)('[Dispatch]');
/**
 * Dispatch a named tool call to the appropriate handler.
 * On unknown names, falls back to the experimental registry; on no match,
 * returns a formatted "Unknown tool" error.
 */
async function dispatchTool(ctx, name, args, options, env) {
    log(`callTool(${name})`);
    const start = Date.now();
    let callResult = 'ok';
    let callError;
    let result;
    try {
        switch (name) {
            case 'browser_tabs':
                result = await (0, navigation_1.onBrowserTabs)(ctx, args, options);
                break;
            case 'browser_navigate':
                result = await (0, navigation_1.onNavigate)(ctx, args, options);
                break;
            case 'browser_interact':
                result = await (0, interaction_1.onInteract)(ctx, args, options);
                break;
            case 'browser_snapshot':
                result = await (0, content_1.onSnapshot)(ctx, options);
                break;
            case 'browser_lookup':
                result = await (0, content_1.onLookup)(ctx, args, options);
                break;
            case 'browser_extract_content':
                result = await (0, content_1.onExtractContent)(ctx, args, options);
                break;
            case 'browser_get_element_styles':
                result = await (0, styles_1.onGetElementStyles)(ctx, args, options);
                break;
            case 'browser_take_screenshot':
                result = await (0, screenshot_1.onScreenshot)(ctx, args, options);
                break;
            case 'browser_evaluate':
                result = await (0, browser_evaluate_1.onEvaluate)(ctx, args, options);
                break;
            case 'browser_console_messages':
                result = await (0, network_1.onConsoleMessages)(ctx, args, options);
                break;
            case 'browser_fill_form':
                result = await (0, forms_1.onFillForm)(ctx, args, options);
                break;
            case 'browser_drag':
                result = await (0, forms_1.onDrag)(ctx, args, options);
                break;
            case 'browser_window':
                result = await (0, misc_1.onWindow)(ctx, args, options);
                break;
            case 'browser_verify_text_visible':
                result = await (0, misc_1.onVerifyTextVisible)(ctx, args, options);
                break;
            case 'browser_verify_element_visible':
                result = await (0, misc_1.onVerifyElementVisible)(ctx, args, options);
                break;
            case 'browser_network_requests':
                result = await (0, network_1.onNetworkRequests)(ctx, args, options);
                break;
            case 'browser_pdf_save':
                result = await (0, screenshot_1.onPdfSave)(ctx, args, options);
                break;
            case 'browser_handle_dialog':
                result = await (0, misc_1.onDialog)(ctx, args, options);
                break;
            case 'browser_list_extensions':
                result = await (0, misc_1.onListExtensions)(ctx, options);
                break;
            case 'browser_performance_metrics':
                result = await (0, misc_1.onPerformanceMetrics)(ctx, options);
                break;
            case 'browser_download':
                result = await (0, downloads_1.onBrowserDownload)(ctx, args, options);
                break;
            case 'secure_fill':
                result = await (0, forms_1.onSecureFill)(ctx, args, options);
                break;
            default: {
                const experimentalResult = await (0, index_1.callExperimentalTool)(name, ctx, args, options);
                if (experimentalResult !== null) {
                    result = experimentalResult;
                    break;
                }
                callResult = 'error';
                callError = `Unknown tool: ${name}`;
                return (0, result_formatter_1.formatError)(callError, options);
            }
        }
        if (result?.isError) {
            callResult = 'error';
            callError = result?.content?.[0]?.text ?? 'unknown error';
        }
        return await (0, result_formatter_1.maybeAppendScreenshot)(name, args, options, result, () => (0, screenshot_1.onScreenshot)(ctx, {}, { rawResult: true }));
    }
    catch (error) {
        log(`Tool error (${name}):`, error.message);
        const msg = error.message || String(error);
        callResult = 'error';
        callError = msg;
        if (/debugger|attach|detach|target closed|session/i.test(msg) &&
            /another|conflict|denied|cannot|failed/i.test(msg)) {
            return (0, result_formatter_1.formatError)(msg + '\n\n' +
                '**Possible extension conflict.** Another extension may be using the Chrome debugger.\n\n' +
                '**Common culprits:** iCloud Passwords, password managers, or other DevTools extensions.\n' +
                'Try disabling other extensions at `chrome://extensions` and retry.', options);
        }
        if (/Target crashed/i.test(msg)) {
            return (0, result_formatter_1.formatError)('The browser tab\'s renderer process crashed.\n\n' +
                '**What this means:** The page hit an unrecoverable error (out-of-memory, native crash, or a heavy DOM operation on a broken page like a `chrome-error://` interstitial). The tab is no longer usable.\n\n' +
                '**Recovery:**\n' +
                '1. Close the crashed tab with `browser_tabs` action `close`\n' +
                '2. Open a fresh tab and re-navigate\n' +
                '3. If this happened after `browser_evaluate` or `browser_lookup` on a failed page, check `browser_navigate` returned the expected URL — error pages can\'t be queried with heavy DOM selectors.', options);
        }
        if (/CDP timeout: Runtime\.evaluate/i.test(msg)) {
            return (0, result_formatter_1.formatError)('JavaScript evaluation in the page timed out (50s).\n\n' +
                '**What this usually means:** The renderer is hung or recovering from a recent crash. Even trivial expressions like `() => 1` hang during the ~50s recovery window after a `Target crashed`.\n\n' +
                '**Recovery:**\n' +
                '1. Wait a few seconds, then retry once\n' +
                '2. If the retry also times out, close the tab (`browser_tabs` action `close`) and open a fresh one\n' +
                '3. Confirm the page actually loaded — `browser_evaluate` against a `chrome-error://` page or a hung navigation will time out repeatedly.', options);
        }
        return (0, result_formatter_1.formatError)(msg, options);
    }
    finally {
        const url = env.getCurrentUrl();
        const sessionId = env.clientId ?? 'unknown';
        const tipsEnabled = ctx.config?.get().tips ?? true;
        const tip = (!options.rawResult && tipsEnabled)
            ? (0, tips_1.getTip)(name, args, callResult, callError, sessionId)
            : null;
        env.metricsLogger?.write({
            session_id: sessionId,
            tool: name,
            params: args,
            result: callResult,
            error: callError,
            url,
            experiments: index_1.experimentRegistry.getStates(),
            duration_ms: Date.now() - start,
            ...(tip ? { tip } : {}),
        });
        if (tip && result?.content?.[0]?.type === 'text') {
            result.content[0].text += `\n\n---\n${tip}`;
        }
    }
}
//# sourceMappingURL=dispatcher.js.map