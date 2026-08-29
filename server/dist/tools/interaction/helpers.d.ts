import type { ToolContext } from '../lib/types';
export declare function getViewportSize(ctx: ToolContext): Promise<{
    width: number;
    height: number;
}>;
/**
 * Resolve the mouse-humanization session key for a tool call.
 *
 * Keyed by the owning ConnectionManager's `client_id` so two managers in one
 * Node process keep separate cursor state. Falls back to '_default' only for
 * contexts built without a connection manager (unit tests) — BrowserBridge
 * always wires one in production.
 */
export declare function humanizationSessionId(ctx: ToolContext): string;
export declare function moveCursorTo(ctx: ToolContext, x: number, y: number): Promise<void>;
export declare function detectSpawnedTabs(ctx: ToolContext, since: number): Promise<string | null>;
export declare const KEY_MAP: Record<string, {
    key: string;
    code: string;
    keyCode: number;
    text: string;
}>;
//# sourceMappingURL=helpers.d.ts.map