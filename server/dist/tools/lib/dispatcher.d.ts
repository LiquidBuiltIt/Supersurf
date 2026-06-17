import type { ToolContext } from './types';
import { UsageMetricsLogger } from '../../usage-metrics-logger';
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
export declare function dispatchTool(ctx: ToolContext, name: string, args: Record<string, unknown>, options: {
    rawResult?: boolean;
}, env: DispatchEnv): Promise<any>;
/**
 * Drain any native-dialog events buffered on the transport since the last
 * tool call and prepend a held-dialog warning to the result's first
 * text block. Multi-step tools (e.g. browser_interact) can fire several
 * extension RPCs per dispatch; aggregating at this layer captures dialogs
 * from every sub-call. Skipped in rawResult mode — script-mode consumers
 * get the raw value with no formatted notice.
 */
declare function prependDialogNotice(result: any, ctx: ToolContext, options: {
    rawResult?: boolean;
}): any;
/** @internal test seam */
export declare const __testPrependDialogNotice: typeof prependDialogNotice;
export {};
//# sourceMappingURL=dispatcher.d.ts.map