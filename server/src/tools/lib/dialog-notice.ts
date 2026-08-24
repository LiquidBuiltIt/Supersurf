/**
 * Shared formatting for buffered native-dialog events into human-readable
 * notice lines. Used by two callers that both drain
 * `IExtensionTransport.consumeDialogEvents()`:
 *   - `dispatcher.ts` (live calls) — prepends the notice to the result.
 *   - `playbooks.ts` (replayed steps) — attaches the notice beneath the
 *     specific step that raised it.
 *
 * @module tools/lib/dialog-notice
 */

import type { DialogEvent } from '../../bridge';

/** Render one warning line per buffered dialog event. */
export function dialogNoticeLines(events: DialogEvent[]): string[] {
  return events.map((d) => {
    const msg = d.message != null && d.message !== '' ? `: ${JSON.stringify(d.message)}` : '';
    const prompt = d.type === 'prompt' && d.defaultPrompt
      ? ` (default: ${JSON.stringify(d.defaultPrompt)})` : '';
    return `⚠ A native ${d.type} dialog is OPEN and blocking the page${msg}${prompt}. ` +
      `Resolve it with browser_handle_dialog {action:"view"} then {action:"accept"} or {action:"dismiss"}.`;
  });
}
