/**
 * Storage Inspection — experimental MCP tool for reading/writing browser storage.
 *
 * Self-contained module: defines the `browser_storage` tool schema, validates
 * input, gates on the `storage_inspection` experiment flag, and delegates
 * actual storage operations to content-script eval via ctx.eval().
 *
 * Supports localStorage and sessionStorage with get/set/delete/clear/list actions.
 *
 * @module experimental/storage-inspection
 *
 * Key exports:
 * - {@link storageInspectionSchema} — MCP tool schema for browser_storage
 * - {@link onBrowserStorage} — handler that validates, gates, and executes storage ops
 */
import type { ToolSchema, ToolContext } from '../tools/types';
export declare const storageInspectionSchema: ToolSchema;
/**
 * Handle a `browser_storage` tool call.
 * Validates the experiment gate, input params, then executes the storage
 * operation in the page context via ctx.eval().
 *
 * @param ctx - Tool context providing eval() and formatting helpers
 * @param args - Tool arguments (type, action, key?, value?)
 * @param options - Pass-through options (rawResult mode)
 * @returns Formatted tool response or error
 */
export declare function onBrowserStorage(ctx: ToolContext, args: Record<string, unknown>, options?: {
    rawResult?: boolean;
}): Promise<any>;
//# sourceMappingURL=storage-inspection.d.ts.map