// server/src/tools/interaction/registry.ts
import type { ToolContext } from '../types';
import type { ActionHandler } from './types';

const registry = new Map<string, ActionHandler>();

export function registerAction(handler: ActionHandler): void {
  if (registry.has(handler.name)) {
    throw new Error(`Action already registered: ${handler.name}`);
  }
  registry.set(handler.name, handler);
}

export async function executeAction(ctx: ToolContext, action: any): Promise<string> {
  const handler = registry.get(action.type);
  if (!handler) throw new Error(`Unknown action type: ${action.type}`);
  return handler.run(ctx, action);
}

export function getRegisteredActions(): readonly string[] {
  return [...registry.keys()];
}

/** Test-only: clear the registry. Do not call from production code. */
export function _clearRegistryForTest(): void {
  registry.clear();
}
