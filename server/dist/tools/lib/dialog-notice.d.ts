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
export declare function dialogNoticeLines(events: DialogEvent[]): string[];
//# sourceMappingURL=dialog-notice.d.ts.map