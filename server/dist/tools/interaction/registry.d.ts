import type { ToolContext } from '../lib/types';
import type { ActionHandler } from './types';
export declare function registerAction(handler: ActionHandler): void;
export declare function executeAction(ctx: ToolContext, action: any): Promise<string>;
export declare function getRegisteredActions(): readonly string[];
/** Test-only: clear the registry. Do not call from production code. */
export declare function _clearRegistryForTest(): void;
//# sourceMappingURL=registry.d.ts.map