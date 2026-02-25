"use strict";
/**
 * BrowserBridge — orchestrator for browser tool dispatch.
 *
 * Central class that AI agents interact with through the MCP protocol.
 * Owns CDP/eval helpers, element resolution utilities, and a switch-based
 * dispatcher that routes tool calls to modular handlers in `tools/`.
 *
 * Every tool handler receives a {@link ToolContext} built by this class,
 * which exposes a controlled subset of bridge internals (CDP, eval, sleep, etc.).
 *
 * @module tools
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserBridge = void 0;
const logger_1 = require("./logger");
const index_1 = require("./experimental/index");
// Tool modules
const schemas_1 = require("./tools/schemas");
const interaction_1 = require("./tools/interaction");
const content_1 = require("./tools/content");
const styles_1 = require("./tools/styles");
const screenshot_1 = require("./tools/screenshot");
const network_1 = require("./tools/network");
const navigation_1 = require("./tools/navigation");
const forms_1 = require("./tools/forms");
const downloads_1 = require("./tools/downloads");
const misc_1 = require("./tools/misc");
const log = (0, logger_1.createLog)('[Bridge]');
/**
 * Orchestrates all browser tool execution.
 *
 * Lifecycle: construct with config + transport, then call {@link initialize}
 * once the MCP server is ready. After that, {@link callTool} dispatches
 * named tool calls to the appropriate handler module.
 */
class BrowserBridge {
    config;
    ext;
    server = null;
    clientInfo = {};
    connectionManager = null;
    constructor(config, ext) {
        this.config = config;
        this.ext = ext;
    }
    /**
     * Bind the MCP server, client metadata, and connection manager.
     * Must be called before any tool dispatch.
     */
    async initialize(server, clientInfo, connectionManager) {
        this.server = server;
        this.clientInfo = clientInfo;
        this.connectionManager = connectionManager;
    }
    /** Cleanup hook called when the MCP server shuts down. */
    serverClosed() {
        log('Server closed');
    }
    // ─── ToolContext factory ──────────────────────────────────────
    /** Build the context object that tool handlers receive */
    get ctx() {
        return {
            ext: this.ext,
            connectionManager: this.connectionManager,
            cdp: this.cdp.bind(this),
            eval: this.evalExpr.bind(this),
            sleep: this.sleep.bind(this),
            getElementCenter: this.getElementCenter.bind(this),
            getSelectorExpression: this.getSelectorExpression.bind(this),
            findAlternativeSelectors: this.findAlternativeSelectors.bind(this),
            formatResult: this.formatResult.bind(this),
            error: this.error.bind(this),
        };
    }
    // ─── CDP + Eval Helpers ─────────────────────────────────────
    /** Send a CDP command through the extension's forwardCDPCommand handler */
    async cdp(method, params = {}) {
        return await this.ext.sendCmd('forwardCDPCommand', { method, params });
    }
    /** Evaluate JS expression in page context, return by value */
    async evalExpr(expression, awaitPromise = true) {
        const result = await this.cdp('Runtime.evaluate', {
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
    /** Sleep for specified ms */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    /** Get center coordinates of an element by selector, with "Did you mean?" hints on failure */
    async getElementCenter(selector) {
        const expr = this.getSelectorExpression(selector);
        const result = await this.evalExpr(`
      (() => {
        const el = ${expr};
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })()
    `);
        if (!result) {
            const hints = await this.findAlternativeSelectors(selector);
            let msg = `Element not found: \`${selector}\``;
            if (hints && hints.length > 0) {
                msg += '\n\nDid you mean?';
                hints.forEach((alt, i) => {
                    const vis = alt.visible ? '' : ' (hidden)';
                    msg += `\n  ${i + 1}. \`${alt.selector}\`${vis}`;
                    if (alt.text)
                        msg += `\n     Text: "${alt.text}"`;
                });
            }
            throw new Error(msg);
        }
        return result;
    }
    /** Search for alternative elements when a selector fails */
    async findAlternativeSelectors(selector) {
        const m = selector.match(/:has-text\(["'](.+?)["']\)/);
        if (!m)
            return [];
        const searchText = m[1];
        try {
            const result = await this.evalExpr(`
        (() => {
          const searchText = ${JSON.stringify(searchText)};
          const searchLower = searchText.trim().toLowerCase();
          const alts = [];

          for (const el of document.querySelectorAll('*')) {
            let directText = '';
            for (const n of el.childNodes) {
              if (n.nodeType === Node.TEXT_NODE) directText += n.textContent;
            }
            directText = directText.trim();
            if (!directText.toLowerCase().includes(searchLower)) continue;

            let sel = el.tagName.toLowerCase();
            if (el.id) {
              sel += '#' + el.id;
            } else if (el.className && typeof el.className === 'string') {
              const cls = el.className.trim().split(/\\\\s+/).filter(Boolean);
              if (cls.length > 0) sel += '.' + cls.slice(0, 2).join('.');
            } else if (el.getAttribute('role')) {
              sel += '[role="' + el.getAttribute('role') + '"]';
            }

            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
                            style.opacity !== '0' && rect.width > 0 && rect.height > 0;

            alts.push({
              selector: sel,
              visible,
              text: directText.length > 50 ? directText.substring(0, 50) + '...' : directText,
            });
          }

          const vis = alts.filter(a => a.visible);
          const hid = alts.filter(a => !a.visible);
          return [...vis.slice(0, 3), ...hid.slice(0, 2)];
        })()
      `);
            return result || [];
        }
        catch {
            return [];
        }
    }
    /** Convert selector string to JS querySelector expression, handling :has-text() */
    getSelectorExpression(selector) {
        if (!selector)
            throw new Error('Selector is required for this action');
        const m = selector.match(/^(.+?):has-text\(["'](.+?)["']\)(.*)$/);
        if (m) {
            const [, base, text] = m;
            return `(() => {
        for (const el of document.querySelectorAll(${JSON.stringify(base)})) {
          if (el.textContent && el.textContent.includes(${JSON.stringify(text)})) return el;
        }
        return null;
      })()`;
        }
        return `document.querySelector(${JSON.stringify(selector)})`;
    }
    // ─── Tool Schemas ────────────────────────────────────────────
    /** Return all registered tool schemas (core + experimental). */
    async listTools() {
        return [...(0, schemas_1.getToolSchemas)(), ...(0, index_1.getExperimentalToolSchemas)()];
    }
    // ─── Inline Screenshot ─────────────────────────────────────
    /** Tools that support the `screenshot` param for inline post-action capture. */
    static SCREENSHOT_ELIGIBLE = new Set([
        'browser_interact', 'browser_navigate', 'browser_fill_form',
        'browser_drag', 'browser_handle_dialog', 'browser_window',
    ]);
    /**
     * If `args.screenshot` is true and the tool is eligible, append a screenshot
     * image block to the result. Skips for rawResult mode and error results.
     */
    async maybeAppendScreenshot(name, args, options, result) {
        if (!args.screenshot || !BrowserBridge.SCREENSHOT_ELIGIBLE.has(name))
            return result;
        if (options.rawResult || result?.isError)
            return result;
        try {
            // Use pre-captured screenshot from navigate handler if available
            let data;
            let mimeType;
            // Check if the navigate result already contains screenshot data (atomic capture)
            // The formatResult may have stringified the result, so check the raw result too
            if (result?._screenshotData) {
                data = result._screenshotData;
                mimeType = result._screenshotMimeType || 'image/jpeg';
            }
            else {
                const screenshotResult = await (0, screenshot_1.onScreenshot)(this.ctx, {}, { rawResult: true });
                data = screenshotResult?.data;
                mimeType = screenshotResult?.mimeType || 'image/jpeg';
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
    // ─── Tool Dispatch ───────────────────────────────────────────
    /**
     * Dispatch a named tool call to the appropriate handler.
     *
     * @param name - MCP tool name (e.g. `browser_tabs`, `browser_interact`)
     * @param args - Tool arguments from the agent
     * @param options - If `rawResult` is true, return raw data instead of MCP content blocks
     * @returns MCP-formatted result with content blocks, or raw data
     */
    async callTool(name, args = {}, options = {}) {
        log(`callTool(${name})`);
        if (!this.ext) {
            return this.error('Extension not connected.\n\n' +
                '**The extension typically auto-connects within a few seconds after calling `enable`. Wait a moment and retry this tool call.**\n\n' +
                '**If the issue persists:**\n' +
                '1. Ensure the SuperSurf extension is loaded in Chrome (`chrome://extensions`)\n' +
                '2. Call the `enable` tool to start the WebSocket server\n' +
                '3. Open the extension popup and verify it shows "Connected"', options);
        }
        const ctx = this.ctx;
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
                    result = await (0, misc_1.onEvaluate)(ctx, args, options);
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
                case 'browser_reload_extensions':
                    result = await (0, misc_1.onReloadExtensions)(ctx, args, options);
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
                    return this.error(`Unknown tool: ${name}`, options);
                }
            }
            return await this.maybeAppendScreenshot(name, args, options, result);
        }
        catch (error) {
            log(`Tool error (${name}):`, error.message);
            const msg = error.message || String(error);
            // Detect CDP/debugger attachment failures that indicate extension conflicts
            if (/debugger|attach|detach|target closed|session/i.test(msg) &&
                /another|conflict|denied|cannot|failed/i.test(msg)) {
                return this.error(msg + '\n\n' +
                    '**Possible extension conflict.** Another extension may be using the Chrome debugger.\n\n' +
                    '**Common culprits:** iCloud Passwords, password managers, or other DevTools extensions.\n' +
                    'Try disabling other extensions at `chrome://extensions` and retry.', options);
            }
            return this.error(msg, options);
        }
    }
    // ─── Helpers ────────────────────────────────────────────────
    /**
     * Wrap a handler result into MCP content blocks, prepending the status header.
     * In rawResult mode, passes through unchanged. Also syncs tab/browser metadata
     * with the connection manager when present in the result.
     */
    formatResult(name, result, options) {
        if (options.rawResult)
            return result;
        // Update connection manager's tab info if result contains it
        if (result && this.connectionManager) {
            if (result.attachedTab)
                this.connectionManager.setAttachedTab(result.attachedTab);
            if (result.browserName)
                this.connectionManager.setConnectedBrowserName(result.browserName);
            if (result.stealthMode !== undefined)
                this.connectionManager.setStealthMode(result.stealthMode);
        }
        const statusHeader = this.connectionManager?.statusHeader() || '';
        // Screenshot image data
        if (result?.data && name === 'browser_take_screenshot') {
            return {
                content: [
                    { type: 'text', text: statusHeader + (result.message || 'Screenshot captured') },
                    { type: 'image', data: result.data, mimeType: result.mimeType || 'image/jpeg' },
                ],
            };
        }
        const text = typeof result === 'string'
            ? result
            : result?.text || result?.message || JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text: statusHeader + text }] };
    }
    /** Format an error as an MCP error block, or as `{ success: false }` in rawResult mode. */
    error(message, options) {
        if (options.rawResult)
            return { success: false, error: message };
        return {
            content: [{ type: 'text', text: `### Error\n\n${message}` }],
            isError: true,
        };
    }
}
exports.BrowserBridge = BrowserBridge;
//# sourceMappingURL=tools.js.map