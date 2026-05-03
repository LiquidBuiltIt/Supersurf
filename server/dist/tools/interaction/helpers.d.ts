import type { ToolContext } from '../lib/types';
export declare function getViewportSize(ctx: ToolContext): Promise<{
    width: number;
    height: number;
}>;
export declare function moveCursorTo(ctx: ToolContext, x: number, y: number, sessionId: string): Promise<void>;
export declare function detectSpawnedTabs(ctx: ToolContext, since: number): Promise<string | null>;
export declare const KEY_MAP: Record<string, {
    key: string;
    code: string;
    keyCode: number;
    text: string;
}>;
//# sourceMappingURL=helpers.d.ts.map