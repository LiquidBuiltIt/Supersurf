"use strict";
// server/src/tools/lib/handler-registry.ts
//
// Tool name → handler mapping, shared by the dispatcher (live calls) and
// playbooks run (replayed steps). Returns null for unknown names so each
// caller owns its own error shape. `playbooks` itself is deliberately
// absent: the dispatcher routes it directly, and including it here would
// create an import cycle (playbooks → registry → playbooks).
Object.defineProperty(exports, "__esModule", { value: true });
exports.callToolHandler = callToolHandler;
const index_1 = require("../../experimental/index");
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
/**
 * Invoke the handler for `name`. Returns the handler's MCP result, or
 * `null` when no built-in or experimental tool matches the name.
 */
async function callToolHandler(ctx, name, args, options) {
    switch (name) {
        case 'browser_tabs': return (0, navigation_1.onBrowserTabs)(ctx, args, options);
        case 'browser_navigate': return (0, navigation_1.onNavigate)(ctx, args, options);
        case 'browser_interact': return (0, interaction_1.onInteract)(ctx, args, options);
        case 'browser_snapshot': return (0, content_1.onSnapshot)(ctx, options);
        case 'browser_lookup': return (0, content_1.onLookup)(ctx, args, options);
        case 'browser_extract_content': return (0, content_1.onExtractContent)(ctx, args, options);
        case 'browser_get_element_styles': return (0, styles_1.onGetElementStyles)(ctx, args, options);
        case 'browser_take_screenshot': return (0, screenshot_1.onScreenshot)(ctx, args, options);
        case 'browser_evaluate': return (0, browser_evaluate_1.onEvaluate)(ctx, args, options);
        case 'browser_console_messages': return (0, network_1.onConsoleMessages)(ctx, args, options);
        case 'browser_fill_form': return (0, forms_1.onFillForm)(ctx, args, options);
        case 'browser_drag': return (0, forms_1.onDrag)(ctx, args, options);
        case 'browser_window': return (0, misc_1.onWindow)(ctx, args, options);
        case 'browser_verify_text_visible': return (0, misc_1.onVerifyTextVisible)(ctx, args, options);
        case 'browser_verify_element_visible': return (0, misc_1.onVerifyElementVisible)(ctx, args, options);
        case 'browser_network_requests': return (0, network_1.onNetworkRequests)(ctx, args, options);
        case 'browser_pdf_save': return (0, screenshot_1.onPdfSave)(ctx, args, options);
        case 'browser_handle_dialog': return (0, misc_1.onDialog)(ctx, args, options);
        case 'browser_list_extensions': return (0, misc_1.onListExtensions)(ctx, options);
        case 'browser_performance_metrics': return (0, misc_1.onPerformanceMetrics)(ctx, options);
        case 'browser_download': return (0, downloads_1.onBrowserDownload)(ctx, args, options);
        case 'secure_fill': return (0, forms_1.onSecureFill)(ctx, args, options);
        default: return (0, index_1.callExperimentalTool)(name, ctx, args, options);
    }
}
//# sourceMappingURL=handler-registry.js.map