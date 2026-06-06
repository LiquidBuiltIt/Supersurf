"use strict";
// server/src/tools/result-formatter.ts
//
// MCP result envelope handling. Three pure functions:
//   - formatResult: wrap a handler result in MCP content blocks, prepend
//     status header, unwrap the `_recovery` envelope, sync tab/browser
//     metadata to the connection manager.
//   - maybeAppendScreenshot: append an inline screenshot image block when
//     the agent passed `screenshot: true` to an eligible tool.
//   - formatError: format an error message as an MCP error block, or a
//     plain `{ success: false }` object in rawResult mode.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCREENSHOT_ELIGIBLE = void 0;
exports.formatResult = formatResult;
exports.maybeAppendScreenshot = maybeAppendScreenshot;
exports.formatError = formatError;
const logger_1 = require("../../logger");
const log = (0, logger_1.createLog)('[ResultFormatter]');
/** Tools that support the `screenshot` param for inline post-action capture. */
exports.SCREENSHOT_ELIGIBLE = new Set([
    'browser_interact', 'browser_navigate', 'browser_fill_form',
    'browser_drag', 'browser_handle_dialog', 'browser_window',
]);
/**
 * Wrap a handler result into MCP content blocks, prepending the status
 * header. In rawResult mode, passes through unchanged. Also syncs tab/
 * browser metadata with the connection manager and unwraps the
 * `_recovery` envelope (extension's `ensureAttachedTab()` attaches one
 * when the attached tab was stale and re-bound mid-call).
 */
function formatResult(name, result, options, cm) {
    if (options.rawResult)
        return result;
    let recoveryNote = '';
    if (result && typeof result === 'object' && '_recovery' in result) {
        const rec = result._recovery;
        if (rec && typeof rec === 'object') {
            const prev = rec.previousTabId ?? '?';
            const next = rec.newTabId ?? '?';
            const url = rec.url ? ` (${rec.url})` : '';
            recoveryNote = `↻ tab recovered: stale tab ${prev} → ${next}${url}\n`;
        }
        if ('value' in result && Object.keys(result).length === 2) {
            result = result.value;
        }
        else {
            const { _recovery, ...rest } = result;
            void _recovery;
            result = rest;
        }
    }
    if (result && typeof result === 'object' && '_dialogs' in result) {
        if ('value' in result && Object.keys(result).length === 2) {
            result = result.value;
        }
        else {
            const { _dialogs, ...rest } = result;
            void _dialogs;
            result = rest;
        }
    }
    if (result && typeof result === 'object' && cm) {
        if (result.attachedTab)
            cm.setAttachedTab?.(result.attachedTab);
        if (result.browserName)
            cm.setConnectedBrowserName?.(result.browserName);
        if (result.stealthMode !== undefined)
            cm.setStealthMode?.(result.stealthMode);
    }
    const statusHeader = cm?.statusHeader?.() || '';
    if (result?.data && name === 'browser_take_screenshot') {
        return {
            content: [
                { type: 'text', text: recoveryNote + statusHeader + (result.message || 'Screenshot captured') },
                { type: 'image', data: result.data, mimeType: result.mimeType || 'image/jpeg' },
            ],
        };
    }
    const text = typeof result === 'string'
        ? result
        : result?.text || result?.message || JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text: recoveryNote + statusHeader + text }] };
}
/**
 * Capture a fresh screenshot via `captureFn` and append it to `result`
 * as an MCP image block, when (a) `args.screenshot` is true, (b) the
 * tool is eligible, and (c) the result is not in raw or error mode.
 *
 * The navigate handler can pre-capture and attach `_screenshotData` to
 * its result; we use that when present to avoid a second capture.
 */
async function maybeAppendScreenshot(name, args, options, result, captureFn) {
    if (!args.screenshot || !exports.SCREENSHOT_ELIGIBLE.has(name))
        return result;
    if (options.rawResult || result?.isError)
        return result;
    try {
        let data;
        let mimeType;
        if (result?._screenshotData) {
            data = result._screenshotData;
            mimeType = result._screenshotMimeType || 'image/jpeg';
        }
        else {
            const captured = await captureFn();
            data = captured?.data;
            mimeType = captured?.mimeType || 'image/jpeg';
        }
        if (data) {
            const imageBlock = { type: 'image', data, mimeType: mimeType || 'image/jpeg' };
            if (result?.content && Array.isArray(result.content)) {
                result.content.push(imageBlock);
            }
        }
    }
    catch (e) {
        log('Inline screenshot failed:', e.message);
    }
    return result;
}
/** Format an error as an MCP error block, or `{ success: false }` in rawResult mode. */
function formatError(message, options) {
    if (options.rawResult)
        return { success: false, error: message };
    return {
        content: [{ type: 'text', text: `### Error\n\n${message}` }],
        isError: true,
    };
}
//# sourceMappingURL=result-formatter.js.map