/**
 * Navigation and tab management tool handlers.
 *
 * Implements `browser_tabs` (list/new/attach/close) and `browser_navigate`
 * (url/back/forward/reload). Tab operations sync metadata (attached tab,
 * stealth mode) with the ConnectionManager. Navigation integrates with
 * the `smart_waiting` experiment for adaptive DOM-stability waits instead
 * of fixed 1500ms delays.
 *
 * @module tools/navigation
 */

import type { ToolContext } from './lib/types';
import { experimentRegistry } from '../experimental/index';

/**
 * Read the attached tab's current URL from the browser process (`getTabs`),
 * NOT via in-page `eval('location.href')`.
 *
 * Why this matters: SPA back-nav (e.g. X's `/compose/post` modal) can tear down
 * a heavy React subtree synchronously in its `popstate` handler, pegging the
 * renderer main thread for tens of seconds. An in-page eval would queue behind
 * that work and block until the ~50s eval timeout. `getTabs` is pure
 * `chrome.tabs.query` + cached metadata — it never touches the renderer, so it
 * returns the post-nav URL instantly even while page JS is frozen. Returns null
 * if the lookup fails (caller surfaces a null URL rather than hanging).
 */
async function getAttachedUrl(ctx: ToolContext): Promise<string | null> {
  try {
    const res: any = await ctx.ext.sendCmd('getTabs', {});
    const tabs: any[] = res?.tabs || [];
    const attached = tabs.find((t) => t.id === res?.attachedTabId) || tabs.find((t) => t.attached);
    return attached?.url ?? null;
  } catch {
    return null;
  }
}

async function checkChromeError(ctx: ToolContext): Promise<string | null> {
  try {
    const raw = await ctx.eval(
      'JSON.stringify({bodyClass: document.body?.className || "", href: location.href})',
    );
    const { bodyClass, href } = JSON.parse(raw);
    if (bodyClass === 'neterror' || (typeof href === 'string' && href.startsWith('chrome-error://'))) {
      return (
        'Navigation succeeded but the page did not load — Chrome displayed an error interstitial ' +
        '(likely network failure, DNS error, or the request was blocked).\n\n' +
        '**Important:** DOM queries against this page can crash the renderer process. Do NOT run ' +
        '`browser_evaluate`, `browser_lookup`, or `browser_snapshot` here — they may hang for ~50s ' +
        'or return `Target crashed`.\n\n' +
        '**Recovery:** Verify network/firewall settings, re-check the URL, or close this tab ' +
        '(`browser_tabs` action `close`) and retry from a fresh tab.'
      );
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Manage browser tabs: list, create, attach (with optional stealth), or close.
 * Updates ConnectionManager metadata on attach/close to keep status headers accurate.
 *
 * @param args - `{ action: 'list'|'new'|'attach'|'close', url?, index?, activate?, stealth? }`
 */
export async function onBrowserTabs(ctx: ToolContext, args: any, options: any): Promise<any> {
  const action = args.action as string;
  let result: any;

  switch (action) {
    case 'list':
      result = await ctx.ext.sendCmd('getTabs', {});
      break;
    case 'new':
      result = await ctx.ext.sendCmd('createTab', {
        url: args.url,
        activate: args.activate !== false,
      });
      break;
    case 'attach':
      result = await ctx.ext.sendCmd('selectTab', {
        index: args.index,
        tabId: args.tabId,
        stealth: args.stealth,
      });
      break;
    case 'close':
      result = await ctx.ext.sendCmd('closeTab', args.index);
      break;
    default:
      return ctx.error(`Unknown tab action: ${action}`, options);
  }

  if (result && ctx.connectionManager) {
    if (action === 'new' || action === 'attach') {
      ctx.connectionManager.setAttachedTab(result);
      if (args.stealth) ctx.connectionManager.setStealthMode(true);
    } else if (action === 'close') {
      ctx.connectionManager.clearAttachedTab();
    }
  }

  return ctx.formatResult('browser_tabs', result, options);
}

/**
 * Navigate the attached tab: go to URL, back, forward, or reload.
 *
 * After navigation, waits for the page to be ready — either via the
 * `smart_waiting` experiment (DOM stability + network idle) or a fixed
 * 1500ms delay as fallback. Pre-captured screenshot data from the
 * extension is forwarded for inline screenshot attachment.
 *
 * @param args - `{ action: 'url'|'back'|'forward'|'reload', url?, screenshot? }`
 */
export async function onNavigate(ctx: ToolContext, args: any, options: any): Promise<any> {
  const action = args.action as string;
  let result: any;

  switch (action) {
    case 'url': {
      const smartWait = experimentRegistry.isEnabled('smart_waiting');
      result = await ctx.ext.sendCmd('navigate', {
        action: 'url',
        url: args.url,
        screenshot: !!args.screenshot,
        smartWait,
        smartWaitStabilityMs: 500,
      });
      if (ctx.connectionManager?.attachedTab) {
        ctx.connectionManager.attachedTab.url = args.url;
      }
      // If extension didn't handle waiting (no screenshot path), wait server-side
      if (!args.screenshot) {
        if (smartWait) {
          try { await ctx.ext.sendCmd('waitForReady', { timeout: 10000, stabilityMs: 500 }); }
          catch { /* fall through — page may already be ready */ }
        } else {
          await ctx.sleep(1500);
        }
      }
      const errMsg = await checkChromeError(ctx);
      if (errMsg) return ctx.error(errMsg, options);
      break;
    }
    case 'back':
      await ctx.eval('window.history.back()');
      // === EXPERIMENTAL: smart waiting ===
      if (experimentRegistry.isEnabled('smart_waiting')) {
        try { await ctx.ext.sendCmd('waitForReady', { timeout: 10000, stabilityMs: 500 }); }
        catch { await ctx.sleep(1500); }
      } else {
        await ctx.sleep(1500);
      }
      result = { success: true, action: 'back', url: await getAttachedUrl(ctx) };
      break;
    case 'forward':
      await ctx.eval('window.history.forward()');
      // === EXPERIMENTAL: smart waiting ===
      if (experimentRegistry.isEnabled('smart_waiting')) {
        try { await ctx.ext.sendCmd('waitForReady', { timeout: 10000, stabilityMs: 500 }); }
        catch { await ctx.sleep(1500); }
      } else {
        await ctx.sleep(1500);
      }
      result = { success: true, action: 'forward', url: await getAttachedUrl(ctx) };
      break;
    case 'reload': {
      result = await ctx.ext.sendCmd('navigate', { action: 'reload' });
      // === EXPERIMENTAL: smart waiting ===
      if (experimentRegistry.isEnabled('smart_waiting')) {
        try { await ctx.ext.sendCmd('waitForReady', { timeout: 10000, stabilityMs: 500 }); }
        catch { /* fall through */ }
      } else {
        await ctx.sleep(1500);
      }
      const errMsg = await checkChromeError(ctx);
      if (errMsg) return ctx.error(errMsg, options);
      break;
    }
    default:
      return ctx.error(`Unknown navigate action: ${action}`, options);
  }

  // Extract screenshot data before formatResult serializes — prevents
  // base64 blob from being dumped into a JSON text block
  const screenshotData = result?.screenshotData;
  const screenshotMimeType = result?.screenshotMimeType;
  if (result) {
    delete result.screenshotData;
    delete result.screenshotMimeType;
  }

  const formatted = ctx.formatResult('browser_navigate', result, options);

  // Forward pre-captured screenshot data for maybeAppendScreenshot
  if (screenshotData && formatted && !options.rawResult) {
    formatted._screenshotData = screenshotData;
    formatted._screenshotMimeType = screenshotMimeType;
  }

  return formatted;
}
