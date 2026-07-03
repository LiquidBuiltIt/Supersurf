import type { IExtensionTransport } from '../../bridge';
/**
 * Send a CDP command through the extension's `forwardCDPCommand` handler.
 *
 * `tabId` pins the command to a specific tab for concurrency isolation; the
 * extension resolves it via `ensureAttachedTab(tabId)` without mutating its
 * shared attached-tab global. Omit to act on the session's attached tab.
 */
export declare function cdp(ext: IExtensionTransport, method: string, params?: any, tabId?: number): Promise<any>;
/**
 * Evaluate a JS expression in the page context via `Runtime.evaluate`.
 * Throws with the page-side exception message when evaluation fails.
 * `tabId` pins evaluation to a specific tab (see `cdp`).
 */
export declare function evalExpr(ext: IExtensionTransport, expression: string, awaitPromise?: boolean, tabId?: number): Promise<any>;
//# sourceMappingURL=cdp.d.ts.map