/**
 * Storage Inspection — MCP tool for reading/writing browser storage.
 *
 * Self-contained module: defines the `browser_storage` tool schema, validates
 * input, and delegates actual storage operations to content-script eval via
 * ctx.eval(). Graduated from the `storage_inspection` experiment in v3.5.0;
 * pre-graduation copy at `experimental/storage-inspection.old.ts`.
 *
 * Supports localStorage and sessionStorage with get/set/delete/clear/list actions.
 *
 * @module tools/browser_storage
 *
 * Key exports:
 * - {@link browserStorageSchema} — MCP tool schema for browser_storage
 * - {@link onBrowserStorage} — handler that validates and executes storage ops
 */
import type { ToolSchema, ToolContext } from './lib/types';
export declare const browserStorageSchema: ToolSchema;
/**
 * Handle a `browser_storage` tool call.
 * Validates input params, then executes the storage operation in the page
 * context via ctx.eval().
 *
 * @param ctx - Tool context providing eval() and formatting helpers
 * @param args - Tool arguments (type, action, key?, value?)
 * @param options - Pass-through options (rawResult mode)
 * @returns Formatted tool response or error
 */
export declare function onBrowserStorage(ctx: ToolContext, args: Record<string, unknown>, options?: {
    rawResult?: boolean;
}): Promise<any>;
//# sourceMappingURL=browser_storage.d.ts.map