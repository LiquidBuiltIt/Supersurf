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
import type { ToolContext } from './types';
/**
 * Manage browser tabs: list, create, attach (with optional stealth), or close.
 * Updates ConnectionManager metadata on attach/close to keep status headers accurate.
 *
 * @param args - `{ action: 'list'|'new'|'attach'|'close', url?, index?, activate?, stealth? }`
 */
export declare function onBrowserTabs(ctx: ToolContext, args: any, options: any): Promise<any>;
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
export declare function onNavigate(ctx: ToolContext, args: any, options: any): Promise<any>;
//# sourceMappingURL=navigation.d.ts.map