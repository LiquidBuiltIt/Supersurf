// server/src/tools/interaction/registry.ts
import type { ToolContext } from '../lib/types';
import type { ActionHandler } from './types';
import { recordAction } from '../../recorder/action-recorder';

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
  const startedAt = Date.now();
  try {
    const result = await handler.run(ctx, action);
    recordAction(ctx, action, startedAt, result, null);
    return result;
  } catch (err) {
    recordAction(ctx, action, startedAt, null, err);
    throw err;
  }
}

export function getRegisteredActions(): readonly string[] {
  return [...registry.keys()];
}

/** Test-only: clear the registry. Do not call from production code. */
export function _clearRegistryForTest(): void {
  registry.clear();
}
