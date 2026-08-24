import type { ToolContext } from './types';
/**
 * Invoke the handler for `name`. Returns the handler's MCP result, or
 * `null` when no built-in or experimental tool matches the name.
 */
export declare function callToolHandler(ctx: ToolContext, name: string, args: Record<string, unknown>, options: {
    rawResult?: boolean;
}): Promise<any | null>;
//# sourceMappingURL=handler-registry.d.ts.map