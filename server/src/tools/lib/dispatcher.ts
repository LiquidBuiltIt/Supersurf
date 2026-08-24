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

import { onScreenshot } from '../screenshot';
import { onPlaybooks } from '../playbooks';
import { callToolHandler } from './handler-registry';

import { maybeAppendScreenshot, formatError } from './result-formatter';
import { dialogNoticeLines } from './dialog-notice';

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
    if (name === 'playbooks') {
      result = await onPlaybooks(ctx, args, options);
    } else {
      result = await callToolHandler(ctx, name, args, options);
      if (result === null) {
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
    //
    // Recording itself is unconditional — rawResult (script mode) still needs
    // trail entries for `playbooks history`/`run` to see. Only the `#<id> `
    // text-prefix mutation is skipped in rawResult mode, matching the
    // untouched-result contract script-mode consumers rely on.
    if (name !== 'browser_interact' && name !== 'playbooks') {
      const id = actionTrail.record({
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

  const notice = dialogNoticeLines(events).join('\n') + '\n';

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
