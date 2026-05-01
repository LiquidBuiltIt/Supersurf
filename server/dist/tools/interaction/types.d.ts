import type { ToolContext } from '../types';
export interface ActionHandler {
    /** Action name as used in browser_interact's `actions[].type` field. */
    name: string;
    /** Execute the action. Returns a human-readable result string. Throws on failure. */
    run(ctx: ToolContext, action: any): Promise<string>;
}
//# sourceMappingURL=types.d.ts.map