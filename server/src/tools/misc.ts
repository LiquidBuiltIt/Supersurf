/**
 * Miscellaneous tool handlers — window, dialog, verify, extensions, performance.
 *
 * Groups smaller tools that don't warrant their own module:
 * - `browser_window`: Resize, minimize, maximize, close
 * - `browser_handle_dialog`: Accept/dismiss alerts, confirms, prompts
 * - `browser_verify_text_visible` / `browser_verify_element_visible`: Page assertions
 * - `browser_list_extensions`: Extension management
 * - `browser_performance_metrics`: Web Vitals + CDP performance data
 *
 * `browser_evaluate` lives in its own home at `tools/browser_evaluate/` (along
 * with the secure_eval AST analyzer + page-context wrapper).
 *
 * @module tools/misc
 */

import type { ToolContext } from './lib/types';

/** Resize, close, minimize, or maximize the browser window. */
export async function onWindow(ctx: ToolContext, args: any, options: any): Promise<any> {
  const result = await ctx.ext.sendCmd('window', {
    action: args.action,
    width: args.width,
    height: args.height,
  });
  return ctx.formatResult('browser_window', result, options);
}

/** Accept or dismiss a browser dialog (alert, confirm, prompt). */
export async function onDialog(ctx: ToolContext, args: any, options: any): Promise<any> {
  if (args.action !== undefined) {
    const result = await ctx.ext.sendCmd('dialog', { action: args.action, text: args.text });
    return ctx.formatResult('browser_handle_dialog', result, options);
  }
  if (args.accept !== undefined) {
    const result = await ctx.ext.sendCmd('dialog', { accept: args.accept, text: args.text });
    return ctx.formatResult('browser_handle_dialog', result, options);
  }
  const result = await ctx.ext.sendCmd('dialog', {});
  return ctx.formatResult('browser_handle_dialog', result, options);
}

/** Assert that specific text is visible in the page body. Returns isError=true when not found. */
export async function onVerifyTextVisible(ctx: ToolContext, args: any, options: any): Promise<any> {
  const text = args.text as string;
  const found = await ctx.eval(`document.body.innerText.includes(${JSON.stringify(text)})`);

  if (options.rawResult) return { visible: found, text };
  return {
    content: [{
      type: 'text',
      text: found ? `✓ Text visible: "${text}"` : `✗ Text not found: "${text}"`,
    }],
    isError: !found,
  };
}

/** Assert that an element matching the selector exists and is visible (not display:none, not zero-size). */
export async function onVerifyElementVisible(ctx: ToolContext, args: any, options: any): Promise<any> {
  const selector = args.selector as string;
  const result = await ctx.eval(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { exists: false, visible: false };
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
                      rect.width > 0 && rect.height > 0;
      return { exists: true, visible };
    })()
  `);

  if (options.rawResult) return result;
  const visible = result?.visible;
  return {
    content: [{
      type: 'text',
      text: visible ? `✓ Element visible: ${selector}` : `✗ Element not visible: ${selector}`,
    }],
    isError: !visible,
  };
}

/** List all installed Chrome extensions. */
export async function onListExtensions(ctx: ToolContext, options: any): Promise<any> {
  const result = await ctx.ext.sendCmd('listExtensions', {});
  return ctx.formatResult('browser_list_extensions', result, options);
}

/**
 * Collect Web Vitals (TTFB, FCP, DOM Content Loaded, Load) from the
 * Performance API and raw CDP metrics from the extension.
 */
export async function onPerformanceMetrics(ctx: ToolContext, options: any): Promise<any> {
  const cdpResult = await ctx.ext.sendCmd('performanceMetrics', {});
  const metrics = cdpResult?.metrics || [];

  const vitals = await ctx.eval(`
    (() => {
      const perf = performance.getEntriesByType('navigation')[0] || {};
      const paint = performance.getEntriesByType('paint') || [];
      const fcp = paint.find(e => e.name === 'first-contentful-paint');

      return {
        ttfb: perf.responseStart ? Math.round(perf.responseStart) : null,
        fcp: fcp ? Math.round(fcp.startTime) : null,
        domContentLoaded: perf.domContentLoadedEventEnd ? Math.round(perf.domContentLoadedEventEnd) : null,
        load: perf.loadEventEnd ? Math.round(perf.loadEventEnd) : null,
      };
    })()
  `).catch(() => null);

  if (options.rawResult) return { metrics, vitals };

  let text = '### Performance Metrics\n\n';

  if (vitals) {
    if (vitals.ttfb != null) text += `TTFB: ${vitals.ttfb}ms\n`;
    if (vitals.fcp != null) text += `FCP: ${vitals.fcp}ms\n`;
    if (vitals.domContentLoaded != null) text += `DOM Content Loaded: ${vitals.domContentLoaded}ms\n`;
    if (vitals.load != null) text += `Load: ${vitals.load}ms\n`;
  }

  if (metrics.length > 0) {
    text += '\n**CDP Metrics:**\n';
    for (const m of metrics) {
      text += `${m.name}: ${m.value}\n`;
    }
  }

  return { content: [{ type: 'text', text }] };
}
