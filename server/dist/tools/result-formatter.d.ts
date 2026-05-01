/** Tools that support the `screenshot` param for inline post-action capture. */
export declare const SCREENSHOT_ELIGIBLE: Set<string>;
/** Minimal connection-manager shape this module needs. */
export interface ResultFormatterCM {
    setAttachedTab?: (tab: any) => void;
    setConnectedBrowserName?: (name: string) => void;
    setStealthMode?: (enabled: boolean) => void;
    statusHeader?: () => string;
}
/**
 * Wrap a handler result into MCP content blocks, prepending the status
 * header. In rawResult mode, passes through unchanged. Also syncs tab/
 * browser metadata with the connection manager and unwraps the
 * `_recovery` envelope (extension's `ensureAttachedTab()` attaches one
 * when the attached tab was stale and re-bound mid-call).
 */
export declare function formatResult(name: string, result: any, options: {
    rawResult?: boolean;
}, cm: ResultFormatterCM | null): any;
/**
 * Capture a fresh screenshot via `captureFn` and append it to `result`
 * as an MCP image block, when (a) `args.screenshot` is true, (b) the
 * tool is eligible, and (c) the result is not in raw or error mode.
 *
 * The navigate handler can pre-capture and attach `_screenshotData` to
 * its result; we use that when present to avoid a second capture.
 */
export declare function maybeAppendScreenshot(name: string, args: Record<string, unknown>, options: {
    rawResult?: boolean;
}, result: any, captureFn: () => Promise<{
    data?: string;
    mimeType?: string;
} | null | undefined>): Promise<any>;
/** Format an error as an MCP error block, or `{ success: false }` in rawResult mode. */
export declare function formatError(message: string, options: {
    rawResult?: boolean;
}): any;
//# sourceMappingURL=result-formatter.d.ts.map