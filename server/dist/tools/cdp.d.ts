import type { IExtensionTransport } from '../bridge';
/** Send a CDP command through the extension's `forwardCDPCommand` handler. */
export declare function cdp(ext: IExtensionTransport, method: string, params?: any): Promise<any>;
/**
 * Evaluate a JS expression in the page context via `Runtime.evaluate`.
 * Throws with the page-side exception message when evaluation fails.
 */
export declare function evalExpr(ext: IExtensionTransport, expression: string, awaitPromise?: boolean): Promise<any>;
//# sourceMappingURL=cdp.d.ts.map