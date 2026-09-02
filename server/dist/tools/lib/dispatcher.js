"use strict";
// server/src/tools/dispatcher.ts
//
// Tool name → handler dispatch. Owns the switch, audit logging,
// CDP-conflict error rewriting, and contextual tip rendering. Pure:
// receives a ToolContext + name/args/options and returns the MCP result.
//
// BrowserBridge just builds the ToolContext and forwards to dispatchTool().
Object.defineProperty(exports, "__esModule", { value: true });
exports.__testPrependDialogNotice = void 0;
exports.dispatchTool = dispatchTool;
const shared_1 = require("../../shared");
const index_1 = require("../../experimental/index");
const tips_1 = require("../../tips");
const trail_1 = require("../../playbooks/trail");
const screenshot_1 = require("../screenshot");
const playbooks_1 = require("../playbooks");
const handler_registry_1 = require("./handler-registry");
const result_formatter_1 = require("./result-formatter");
const dialog_notice_1 = require("./dialog-notice");
const log = (0, shared_1.createLog)('[Dispatch]');
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
        if (name === 'playbooks') {
            result = await (0, playbooks_1.onPlaybooks)(ctx, args, options);
        }
        else {
            result = await (0, handler_registry_1.callToolHandler)(ctx, name, args, options);
            if (result === null) {
                callResult = 'error';
                callError = `Unknown tool: ${name}`;
                result = (0, result_formatter_1.formatError)(callError, options);
                return result;
            }
        }
        if (result?.isError) {
            callResult = 'error';
            callError = result?.content?.[0]?.text ?? 'unknown error';
        }
        result = await (0, result_formatter_1.maybeAppendScreenshot)(name, args, options, result, () => (0, screenshot_1.onScreenshot)(ctx, {}, { rawResult: true }));
        return result;
    }
    catch (error) {
        log(`Tool error (${name}):`, error.message);
        const msg = error.message || String(error);
        callResult = 'error';
        callError = msg;
        if (/debugger|attach|detach|target closed|session/i.test(msg) &&
            /another|conflict|denied|cannot|failed/i.test(msg)) {
            result = (0, result_formatter_1.formatError)(msg + '\n\n' +
                '**Possible extension conflict.** Another extension may be using the Chrome debugger.\n\n' +
                '**Common culprits:** iCloud Passwords, password managers, or other DevTools extensions.\n' +
                'Try disabling other extensions at `chrome://extensions` and retry.', options);
            return result;
        }
        if (/Target crashed/i.test(msg)) {
            result = (0, result_formatter_1.formatError)('The browser tab\'s renderer process crashed.\n\n' +
                '**What this means:** The page hit an unrecoverable error (out-of-memory, native crash, or a heavy DOM operation on a broken page like a `chrome-error://` interstitial). The tab is no longer usable.\n\n' +
                '**Recovery:**\n' +
                '1. Close the crashed tab with `browser_tabs` action `close`\n' +
                '2. Open a fresh tab and re-navigate\n' +
                '3. If this happened after `browser_evaluate` or `browser_lookup` on a failed page, check `browser_navigate` returned the expected URL — error pages can\'t be queried with heavy DOM selectors.', options);
            return result;
        }
        if (/CDP timeout: Runtime\.evaluate/i.test(msg)) {
            result = (0, result_formatter_1.formatError)('JavaScript evaluation in the page timed out (50s).\n\n' +
                '**What this usually means:** The renderer is hung or recovering from a recent crash. Even trivial expressions like `() => 1` hang during the ~50s recovery window after a `Target crashed`.\n\n' +
                '**Recovery:**\n' +
                '1. Wait a few seconds, then retry once\n' +
                '2. If the retry also times out, close the tab (`browser_tabs` action `close`) and open a fresh one\n' +
                '3. Confirm the page actually loaded — `browser_evaluate` against a `chrome-error://` page or a hung navigation will time out repeatedly.', options);
            return result;
        }
        result = (0, result_formatter_1.formatError)(msg, options);
        return result;
    }
    finally {
        result = prependDialogNotice(result, ctx, options);
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
        // Action id. `browser_interact` is excluded because onInteract already
        // recorded one entry per action in its array — a call-level entry here
        // would double-count. `playbooks` is excluded because it is the tool that
        // READS the trail; recording its own calls would let a history read appear
        // in the next history read.
        //
        // Recording itself is unconditional — rawResult (script mode) still needs
        // trail entries for `playbooks history`/`run` to see. Only the `#<id> `
        // text-prefix mutation is skipped in rawResult mode, matching the
        // untouched-result contract script-mode consumers rely on.
        if (name !== 'browser_interact' && name !== 'playbooks') {
            const id = trail_1.actionTrail.record({
                tool: name,
                type: name,
                outcome: callResult === 'error' ? 'error' : 'ok',
                message: callError ?? 'ok',
                params: args,
                url,
            });
            if (!options.rawResult && result?.content?.[0]?.type === 'text') {
                result.content[0].text = `#${id} ${result.content[0].text}`;
            }
        }
        if (tip && result?.content?.[0]?.type === 'text') {
            result.content[0].text += `\n\n---\n${tip}`;
        }
    }
}
/**
 * Drain any native-dialog events buffered on the transport since the last
 * tool call and prepend a held-dialog warning to the result's first
 * text block. Multi-step tools (e.g. browser_interact) can fire several
 * extension RPCs per dispatch; aggregating at this layer captures dialogs
 * from every sub-call. Skipped in rawResult mode — script-mode consumers
 * get the raw value with no formatted notice.
 */
function prependDialogNotice(result, ctx, options) {
    const transport = ctx.ext;
    if (typeof transport?.consumeDialogEvents !== 'function')
        return result;
    const events = transport.consumeDialogEvents();
    if (!events || events.length === 0)
        return result;
    if (options.rawResult)
        return result;
    const notice = (0, dialog_notice_1.dialogNoticeLines)(events).join('\n') + '\n';
    if (result && Array.isArray(result.content)) {
        const firstText = result.content.find((b) => b?.type === 'text');
        if (firstText) {
            firstText.text = notice + firstText.text;
        }
        else {
            result.content.unshift({ type: 'text', text: notice });
        }
    }
    return result;
}
/** @internal test seam */
exports.__testPrependDialogNotice = prependDialogNotice;
//# sourceMappingURL=dispatcher.js.map