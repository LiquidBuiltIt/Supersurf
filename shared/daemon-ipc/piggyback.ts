/**
 * The piggyback a tool result carries: `currentTab` (pushed to a callback) and
 * `_dialogs` (native-dialog events, stripped from the result). One copy for
 * `DaemonClient` and the daemon's worker-side `PortLink`.
 *
 * @module daemon-ipc/piggyback
 */
import type { DialogEvent } from './types';

/** Fire the tab callback, strip `_dialogs` from `result` in place, and return those events. */
export function takePiggyback(result: unknown, onTabInfoUpdate: ((tabInfo: any) => void) | null): DialogEvent[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as any;
  if ('currentTab' in r && onTabInfoUpdate) onTabInfoUpdate(r.currentTab);
  if (!Array.isArray(r._dialogs)) return [];
  const dialogs = r._dialogs as DialogEvent[];
  delete r._dialogs;
  return dialogs;
}
