/**
 * @module handlers/dialogs
 *
 * Transparent native-dialog handling. The CDP debugger (Page domain enabled
 * at attach) HOLDS every JavaScript dialog (alert/confirm/prompt/beforeunload)
 * open until the agent decides. This handler records the currently-held dialog
 * and resolves it via `Page.handleJavaScriptDialog`. It does NOT auto-answer —
 * opinionated auto-handling is reserved for a future opt-in smart mode.
 *
 * Adapted from Blueprint MCP (Apache 2.0).
 */

import { Logger } from '../utils/logger.js';

export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

/** A native dialog currently held open by CDP, awaiting an agent decision. */
export interface HeldDialog {
  type: DialogType;
  message: string;
  defaultPrompt: string;
  url: string;
  hasBrowserHandler: boolean;
  timestamp: number;
}

/** Raw shape of the CDP `Page.javascriptDialogOpening` event params. */
interface DialogOpeningParams {
  type: DialogType;
  message?: string;
  defaultPrompt?: string;
  url?: string;
  hasBrowserHandler?: boolean;
}

/**
 * Tracks the single currently-held native dialog and resolves it through CDP.
 * Only one JS dialog can be open per renderer at a time, so a single slot
 * suffices.
 */
export class DialogHandler {
  private browser: typeof chrome;
  private logger: Logger;
  private pending: HeldDialog | null = null;

  constructor(browserAPI: typeof chrome, logger: Logger) {
    this.browser = browserAPI;
    this.logger = logger;
  }

  /** Record a dialog that CDP just held open. Called from the debugger event listener. */
  onDialogOpening(params: DialogOpeningParams): void {
    this.pending = {
      type: params.type,
      message: params.message ?? '',
      defaultPrompt: params.defaultPrompt ?? '',
      url: params.url ?? '',
      hasBrowserHandler: !!params.hasBrowserHandler,
      timestamp: Date.now(),
    };
    this.logger.log('[DialogHandler] held', this.pending.type, JSON.stringify(this.pending.message));
  }

  /** The currently-held dialog, or null if none is open. */
  getPending(): HeldDialog | null {
    return this.pending;
  }

  /** Forget the held dialog without touching CDP (used on detach / navigation). */
  clearPending(): void {
    this.pending = null;
  }

  /**
   * Resolve the held dialog via CDP. `accept=true` clicks OK (and supplies
   * `promptText` for prompt dialogs); `accept=false` clicks Cancel. Unfreezes
   * the renderer. Always clears the pending slot, even when CDP reports no
   * dialog is showing (it may have been resolved by a navigation in between).
   */
  async handle(tabId: number, accept: boolean, promptText: string): Promise<void> {
    try {
      await (this.browser as any)['debugger'].sendCommand(
        { tabId },
        'Page.handleJavaScriptDialog',
        { accept, promptText: promptText || '' },
      );
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (!/no dialog is showing/i.test(msg)) throw e;
    }
    this.pending = null;
  }
}
