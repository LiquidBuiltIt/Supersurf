// server/src/tools/lib/handler-registry.ts
//
// Tool name → handler mapping, shared by the dispatcher (live calls) and
// playbooks run (replayed steps). Returns null for unknown names so each
// caller owns its own error shape. `playbooks` itself is deliberately
// absent: the dispatcher routes it directly, and including it here would
// create an import cycle (playbooks → registry → playbooks).

import type { ToolContext } from './types';
import { callExperimentalTool } from '../../experimental/index';

import { onInteract } from '../interaction';
import { onSnapshot, onLookup, onExtractContent } from '../content';
import { onGetElementStyles } from '../styles';
import { onScreenshot, onPdfSave } from '../screenshot';
import { onNetworkRequests, onConsoleMessages } from '../network';
import { onBrowserTabs, onNavigate } from '../navigation';
import { onFillForm, onDrag, onSecureFill } from '../forms';
import { onBrowserDownload } from '../downloads';
import {
  onWindow, onDialog,
  onVerifyTextVisible, onVerifyElementVisible,
  onListExtensions, onPerformanceMetrics,
} from '../misc';
import { onEvaluate } from '../browser_evaluate';

/**
 * Invoke the handler for `name`. Returns the handler's MCP result, or
 * `null` when no built-in or experimental tool matches the name.
 */
export async function callToolHandler(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
  options: { rawResult?: boolean },
): Promise<any | null> {
  switch (name) {
    case 'browser_tabs':            return onBrowserTabs(ctx, args, options);
    case 'browser_navigate':        return onNavigate(ctx, args, options);
    case 'browser_interact':        return onInteract(ctx, args, options);
    case 'browser_snapshot':        return onSnapshot(ctx, options);
    case 'browser_lookup':          return onLookup(ctx, args, options);
    case 'browser_extract_content': return onExtractContent(ctx, args, options);
    case 'browser_get_element_styles': return onGetElementStyles(ctx, args, options);
    case 'browser_take_screenshot': return onScreenshot(ctx, args, options);
    case 'browser_evaluate':        return onEvaluate(ctx, args, options);
    case 'browser_console_messages': return onConsoleMessages(ctx, args, options);
    case 'browser_fill_form':       return onFillForm(ctx, args, options);
    case 'browser_drag':            return onDrag(ctx, args, options);
    case 'browser_window':          return onWindow(ctx, args, options);
    case 'browser_verify_text_visible':    return onVerifyTextVisible(ctx, args, options);
    case 'browser_verify_element_visible': return onVerifyElementVisible(ctx, args, options);
    case 'browser_network_requests': return onNetworkRequests(ctx, args, options);
    case 'browser_pdf_save':        return onPdfSave(ctx, args, options);
    case 'browser_handle_dialog':   return onDialog(ctx, args, options);
    case 'browser_list_extensions': return onListExtensions(ctx, options);
    case 'browser_performance_metrics': return onPerformanceMetrics(ctx, options);
    case 'browser_download':        return onBrowserDownload(ctx, args, options);
    case 'secure_fill':             return onSecureFill(ctx, args, options);
    default:                        return callExperimentalTool(name, ctx, args, options);
  }
}
