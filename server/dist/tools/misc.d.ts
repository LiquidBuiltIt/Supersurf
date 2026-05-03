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
export declare function onWindow(ctx: ToolContext, args: any, options: any): Promise<any>;
/** Accept or dismiss a browser dialog (alert, confirm, prompt). */
export declare function onDialog(ctx: ToolContext, args: any, options: any): Promise<any>;
/** Assert that specific text is visible in the page body. Returns isError=true when not found. */
export declare function onVerifyTextVisible(ctx: ToolContext, args: any, options: any): Promise<any>;
/** Assert that an element matching the selector exists and is visible (not display:none, not zero-size). */
export declare function onVerifyElementVisible(ctx: ToolContext, args: any, options: any): Promise<any>;
/** List all installed Chrome extensions. */
export declare function onListExtensions(ctx: ToolContext, options: any): Promise<any>;
/**
 * Collect Web Vitals (TTFB, FCP, DOM Content Loaded, Load) from the
 * Performance API and raw CDP metrics from the extension.
 */
export declare function onPerformanceMetrics(ctx: ToolContext, options: any): Promise<any>;
//# sourceMappingURL=misc.d.ts.map