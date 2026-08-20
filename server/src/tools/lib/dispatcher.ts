// server/src/tools/dispatcher.ts
//
// Tool name → handler dispatch. Owns the switch, audit logging,
// CDP-conflict error rewriting, and contextual tip rendering. Pure:
// receives a ToolContext + name/args/options and returns the MCP result.
//
// BrowserBridge just builds the ToolContext and forwards to dispatchTool().

import type { ToolContext } from './types';
import { createLog } from '../../logger';
import { UsageMetricsLogger } from '../../usage-metrics-logger';
import { callExperimentalTool, experimentRegistry } from '../../experimental/index';
import { getTip } from '../../tips';
import { actionTrail } from '../../playbooks/trail';

import { onInteract } from '../interaction';
import { onSnapshot, onLookup, onExtractContent } from '../content';
import { onGetElementStyles } from '../styles';
import { onScreenshot, onPdfSave } from '../screenshot';
import { onNetworkRequests, onConsoleMessages } from '../network';
import { onBrowserTabs, onNavigate } from '../navigation';
import { onFillForm, onDrag, onSecureFill } from '../forms';
import { onBrowserDownload } from '../downloads';
import { onPlaybooks } from '../playbooks';
import {
  onWindow, onDialog,
  onVerifyTextVisible, onVerifyElementVisible,
  onListExtensions, onPerformanceMetrics,
} from '../misc';
import { onEvaluate } from '../browser_evaluate';

import { maybeAppendScreenshot, formatError } from './result-formatter';

const log = createLog('[Dispatch]');

/** Side-channel data dispatchTool needs to write to (usage-metrics log + connection state). */
export interface DispatchEnv {
  metricsLogger: UsageMetricsLogger | null;
  /** Used for the `session_id` field in metrics entries. */
  clientId: string | null | undefined;
  /** Read for the `url` field in metrics entries (current attached tab URL). */
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
      case 'playbooks':               result = await onPlaybooks(ctx, args, options); break;
      default: {
        const experimentalResult = await callExperimentalTool(name, ctx, args, options);
        if (experimentalResult !== null) { result = experimentalResult; break; }
        callResult = 'error';
        callError = `Unknown tool: ${name}`;
        result = formatError(callError, options);
        return result;
      }
    }

    if (result?.isError) {
      callResult = 'error';
      callError = result?.content?.[0]?.text ?? 'unknown error';
    }

    result = await maybeAppendScreenshot(
      name,
      args,
      options,
      result,
      () => onScreenshot(ctx, {}, { rawResult: true }),
    );
    return result;
  } catch (error: any) {
    log(`Tool error (${name}):`, error.message);
    const msg = error.message || String(error);
    callResult = 'error';
    callError = msg;

    if (/debugger|attach|detach|target closed|session/i.test(msg) &&
        /another|conflict|denied|cannot|failed/i.test(msg)) {
      result = formatError(
        msg + '\n\n' +
        '**Possible extension conflict.** Another extension may be using the Chrome debugger.\n\n' +
        '**Common culprits:** iCloud Passwords, password managers, or other DevTools extensions.\n' +
        'Try disabling other extensions at `chrome://extensions` and retry.',
        options,
      );
      return result;
    }

    if (/Target crashed/i.test(msg)) {
      result = formatError(
        'The browser tab\'s renderer process crashed.\n\n' +
        '**What this means:** The page hit an unrecoverable error (out-of-memory, native crash, or a heavy DOM operation on a broken page like a `chrome-error://` interstitial). The tab is no longer usable.\n\n' +
        '**Recovery:**\n' +
        '1. Close the crashed tab with `browser_tabs` action `close`\n' +
        '2. Open a fresh tab and re-navigate\n' +
        '3. If this happened after `browser_evaluate` or `browser_lookup` on a failed page, check `browser_navigate` returned the expected URL — error pages can\'t be queried with heavy DOM selectors.',
        options,
      );
      return result;
    }

    if (/CDP timeout: Runtime\.evaluate/i.test(msg)) {
      result = formatError(
        'JavaScript evaluation in the page timed out (50s).\n\n' +
        '**What this usually means:** The renderer is hung or recovering from a recent crash. Even trivial expressions like `() => 1` hang during the ~50s recovery window after a `Target crashed`.\n\n' +
        '**Recovery:**\n' +
        '1. Wait a few seconds, then retry once\n' +
        '2. If the retry also times out, close the tab (`browser_tabs` action `close`) and open a fresh one\n' +
        '3. Confirm the page actually loaded — `browser_evaluate` against a `chrome-error://` page or a hung navigation will time out repeatedly.',
        options,
      );
      return result;
    }

    result = formatError(msg, options);
    return result;
  } finally {
    result = prependDialogNotice(result, ctx, options);
    const url = env.getCurrentUrl();
    const sessionId = env.clientId ?? 'unknown';
    const tipsEnabled = ctx.config?.get().tips ?? true;
    const tip = (!options.rawResult && tipsEnabled)
      ? getTip(name, args, callResult, callError, sessionId)
      : null;

    env.metricsLogger?.write({
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

    // Action id. `browser_interact` is excluded because onInteract already
    // recorded one entry per action in its array — a call-level entry here
    // would double-count. `playbooks` is excluded because it is the tool that
    // READS the trail; recording its own calls would let a history read appear
    // in the next history read.
    if (!options.rawResult && name !== 'browser_interact' && name !== 'playbooks') {
      const id = actionTrail.record({
        tool: name,
        type: name,
        outcome: callResult === 'error' ? 'error' : 'ok',
        message: callError ?? 'ok',
        params: args,
        url,
      });
      if (result?.content?.[0]?.type === 'text') {
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
function prependDialogNotice(
  result: any,
  ctx: ToolContext,
  options: { rawResult?: boolean },
): any {
  const transport: any = ctx.ext;
  if (typeof transport?.consumeDialogEvents !== 'function') return result;

  const events = transport.consumeDialogEvents();
  if (!events || events.length === 0) return result;
  if (options.rawResult) return result;

  const lines = events.map((d: any) => {
    const msg = d.message != null && d.message !== '' ? `: ${JSON.stringify(d.message)}` : '';
    const prompt = d.type === 'prompt' && d.defaultPrompt
      ? ` (default: ${JSON.stringify(d.defaultPrompt)})` : '';
    return `⚠ A native ${d.type} dialog is OPEN and blocking the page${msg}${prompt}. ` +
      `Resolve it with browser_handle_dialog {action:"view"} then {action:"accept"} or {action:"dismiss"}.`;
  });
  const notice = lines.join('\n') + '\n';

  if (result && Array.isArray(result.content)) {
    const firstText = result.content.find((b: any) => b?.type === 'text');
    if (firstText) {
      firstText.text = notice + firstText.text;
    } else {
      result.content.unshift({ type: 'text', text: notice });
    }
  }

  return result;
}

/** @internal test seam */
export const __testPrependDialogNotice = prependDialogNotice;
