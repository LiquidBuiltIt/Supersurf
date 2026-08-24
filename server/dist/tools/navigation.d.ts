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
export declare function getAttachedUrl(ctx: ToolContext): Promise<string | null>;
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