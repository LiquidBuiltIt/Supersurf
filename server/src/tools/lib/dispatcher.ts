// server/src/tools/dispatcher.ts
//
// Tool name → handler dispatch. Owns the switch, audit logging,
// CDP-conflict error rewriting, and contextual tip rendering. Pure:
// receives a ToolContext + name/args/options and returns the MCP result.
//
// BrowserBridge just builds the ToolContext and forwards to dispatchTool().

import type { ToolContext } from './types';
import { createLog } from '../../logger';
import { AuditLogger } from '../../audit-logger';
import { callExperimentalTool, experimentRegistry } from '../../experimental/index';
import { getTip } from '../../tips';

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

import { maybeAppendScreenshot, formatError } from './result-formatter';

const log = createLog('[Dispatch]');

/** Side-channel data dispatchTool needs to write to (audit log + connection state). */
export interface DispatchEnv {
  auditLogger: AuditLogger | null;
  /** Used for the `session_id` field in audit entries. */
  clientId: string | null | undefined;
  /** Read for the `url` field in audit entries (current attached tab URL). */
  getCurrentUrl: () => string | undefined;
}

/**
 * Dispatch a named tool call to the appropriate handler.
 * On unknown names, falls back to the experimental registry; on no match,
 * returns a formatted "Unknown tool" error.
 */
export async function dispatchTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
  options: { rawResult?: boolean },
  env: DispatchEnv,
): Promise<any> {
  log(`callTool(${name})`);

  const start = Date.now();
  let callResult: 'ok' | 'error' = 'ok';
  let callError: string | undefined;
  let result: any;

  try {
    switch (name) {
      case 'browser_tabs':            result = await onBrowserTabs(ctx, args, options); break;
      case 'browser_navigate':        result = await onNavigate(ctx, args, options); break;
      case 'browser_interact':        result = await onInteract(ctx, args, options); break;
      case 'browser_snapshot':        result = await onSnapshot(ctx, options); break;
      case 'browser_lookup':          result = await onLookup(ctx, args, options); break;
      case 'browser_extract_content': result = await onExtractContent(ctx, args, options); break;
      case 'browser_get_element_styles': result = await onGetElementStyles(ctx, args, options); break;
      case 'browser_take_screenshot': result = await onScreenshot(ctx, args, options); break;
      case 'browser_evaluate':        result = await onEvaluate(ctx, args, options); break;
      case 'browser_console_messages': result = await onConsoleMessages(ctx, args, options); break;
      case 'browser_fill_form':       result = await onFillForm(ctx, args, options); break;
      case 'browser_drag':            result = await onDrag(ctx, args, options); break;
      case 'browser_window':          result = await onWindow(ctx, args, options); break;
      case 'browser_verify_text_visible':    result = await onVerifyTextVisible(ctx, args, options); break;
      case 'browser_verify_element_visible': result = await onVerifyElementVisible(ctx, args, options); break;
      case 'browser_network_requests': result = await onNetworkRequests(ctx, args, options); break;
      case 'browser_pdf_save':        result = await onPdfSave(ctx, args, options); break;
      case 'browser_handle_dialog':   result = await onDialog(ctx, args, options); break;
      case 'browser_list_extensions': result = await onListExtensions(ctx, options); break;
      case 'browser_performance_metrics': result = await onPerformanceMetrics(ctx, options); break;
      case 'browser_download':        result = await onBrowserDownload(ctx, args, options); break;
      case 'secure_fill':             result = await onSecureFill(ctx, args, options); break;
      default: {
        const experimentalResult = await callExperimentalTool(name, ctx, args, options);
        if (experimentalResult !== null) { result = experimentalResult; break; }
        callResult = 'error';
        callError = `Unknown tool: ${name}`;
        return formatError(callError, options);
      }
    }

    if (result?.isError) {
      callResult = 'error';
      callError = result?.content?.[0]?.text ?? 'unknown error';
    }

    return await maybeAppendScreenshot(
      name,
      args,
      options,
      result,
      () => onScreenshot(ctx, {}, { rawResult: true }),
    );
  } catch (error: any) {
    log(`Tool error (${name}):`, error.message);
    const msg = error.message || String(error);
    callResult = 'error';
    callError = msg;

    if (/debugger|attach|detach|target closed|session/i.test(msg) &&
        /another|conflict|denied|cannot|failed/i.test(msg)) {
      return formatError(
        msg + '\n\n' +
        '**Possible extension conflict.** Another extension may be using the Chrome debugger.\n\n' +
        '**Common culprits:** iCloud Passwords, password managers, or other DevTools extensions.\n' +
        'Try disabling other extensions at `chrome://extensions` and retry.',
        options,
      );
    }

    return formatError(msg, options);
  } finally {
    const url = env.getCurrentUrl();
    const sessionId = env.clientId ?? 'unknown';
    const tip = !options.rawResult ? getTip(name, args, callResult, callError, sessionId) : null;

    env.auditLogger?.write({
      session_id: sessionId,
      tool: name,
      params: args,
      result: callResult,
      error: callError,
      url,
      experiments: experimentRegistry.getStates(),
      duration_ms: Date.now() - start,
      ...(tip ? { tip } : {}),
    });

    if (tip && result?.content?.[0]?.type === 'text') {
      result.content[0].text += `\n\n---\n${tip}`;
    }
  }
}
