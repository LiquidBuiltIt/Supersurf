import type { ToolContext } from './types';
import { AuditLogger } from '../../audit-logger';
/** Side-channel data dispatchTool needs to write to (audit log + connection state). */
export interface DispatchEnv {
    auditLogger: AuditLogger | null;
    /** Used for the `session_id` field in audit entries. */
    clientId: string | null | undefined;
    /** Read for the `url` field in audit entries (current attached tab URL). */
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
//# sourceMappingURL=dispatcher.d.ts.map