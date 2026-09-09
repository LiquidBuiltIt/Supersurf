// server/src/tools/interaction/registry.ts
import type { ToolContext } from '../lib/types';
import type { ActionHandler } from './types';
import { recordAction } from '../../recorder/action-recorder';

const registry = new Map<string, ActionHandler>();

/**
 * Actions that dispatch real CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`
 * events. Chrome silently no-ops these when the tab isn't the foreground tab of its
 * window (`document.visibilityState === 'hidden'`) — no request, no console error,
 * no exception, just a dropped event, while the tool still reports success.
 * Actions that only read the page or act purely through DOM calls (scroll_to/by/
 * into_view, clear, select_option, force_pseudo_state, file_upload, wait) don't go
 * through CDP input dispatch and are unaffected — they stay out of this set.
 */
const VISIBILITY_GATED_ACTIONS = new Set([
  'click', 'mouse_click', 'mouse_move', 'hover', 'type', 'press_key', 'select_custom',
]);

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
    if (VISIBILITY_GATED_ACTIONS.has(action.type)) {
      // Fail open on an unreadable page (dead tab, mid-navigation): only a
      // definite "hidden" blocks. A guard that turns an eval hiccup into a
      // refused action would break interactions that worked before it existed.
      const visibility = await ctx.eval('document.visibilityState').catch(() => null);
      if (visibility === 'hidden') {
        throw new Error(
          `Cannot ${action.type}: the attached tab is not the foreground tab of its Chromium window ` +
          `(document.visibilityState is "hidden"). CDP input events silently no-op on background tabs — ` +
          `this action would have reported success without landing. Fix: re-attach the tab ` +
          `(browser_tabs action='attach') with activate: true, or create it with activate: true, then retry.`
        );
      }
    }
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
