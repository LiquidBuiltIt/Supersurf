/**
 * @module handlers/dialogs
 *
 * Auto-handles browser dialogs (alert, confirm, prompt) by replacing the
 * native window methods with non-blocking stubs injected into MAIN world.
 * Dialog events are logged to `window.__supersurfDialogEvents` for later
 * retrieval by the MCP server.
 *
 * Key exports:
 * - {@link DialogHandler} — injection + event retrieval
 *
 * Adapted from Blueprint MCP (Apache 2.0)
 */

import { Logger } from '../utils/logger.js';

/**
 * Shape of a dialog event recorded by the MAIN-world overrides for
 * `window.alert`, `window.confirm`, and `window.prompt`. `response` is a
 * string for alerts (`'accepted'`) and confirms (`'accepted'` | `'dismissed'`),
 * or the typed value (or `null` if dismissed) for prompts.
 */
export interface DialogEvent {
  type: string;
  message: string;
  response: string | null;
  timestamp: number;
}

/**
 * Replaces `window.alert`, `window.confirm`, and `window.prompt` with
 * synchronous stubs that log events and return configurable responses.
 * This prevents dialogs from blocking page automation.
 */
export class DialogHandler {
  private browser: typeof chrome;
  private logger: Logger;
  /** Sync buffer of dialog events drained from the page since the last consume. */
  private eventBuffer: DialogEvent[] = [];
  /** Tab whose event log we're draining periodically. */
  private drainTabId: number | null = null;
  /** Drain interval timer id. */
  private drainInterval: any = null;

  constructor(browserAPI: typeof chrome, logger: Logger) {
    this.browser = browserAPI;
    this.logger = logger;
  }

  /**
   * Inject dialog overrides into the page's MAIN world.
   * @param tabId - Target tab
   * @param accept - Whether confirm() returns true and prompt() returns a value
   * @param promptText - Text returned by prompt() when accepted
   */
  async setupDialogOverrides(
    tabId: number,
    accept: boolean = false,
    promptText: string = ''
  ): Promise<void> {
    try {
      await this.browser.scripting.executeScript({
        target: { tabId },
        world: 'MAIN' as any,
        func: (shouldAccept: boolean, text: string) => {
          if (!(window as any).__supersurfDialogEvents) {
            (window as any).__supersurfDialogEvents = [];
          }

          window.alert = (msg?: string) => {
            (window as any).__supersurfDialogEvents.push({
              type: 'alert',
              message: msg,
              response: 'accepted',
              timestamp: Date.now(),
            });
          };

          window.confirm = (msg?: string): boolean => {
            (window as any).__supersurfDialogEvents.push({
              type: 'confirm',
              message: msg,
              response: shouldAccept ? 'accepted' : 'dismissed',
              timestamp: Date.now(),
            });
            return shouldAccept;
          };

          window.prompt = (msg?: string, defaultValue?: string): string | null => {
            const value = shouldAccept ? (text || defaultValue || '') : null;
            (window as any).__supersurfDialogEvents.push({
              type: 'prompt',
              message: msg,
              response: value,
              timestamp: Date.now(),
            });
            return value;
          };
        },
        args: [accept, promptText],
      });
    } catch (e: any) {
      this.logger.log('[DialogHandler] Failed to inject:', e.message);
      throw e;
    }
  }

  /**
   * Fire CDP `Page.handleJavaScriptDialog` blind to dismiss any native
   * dialog that escaped the MAIN-world override (e.g. fired by a script
   * that ran before the override was injected, or fired in an iframe).
   *
   * If no dialog is open, CDP returns "No dialog is showing." — we
   * swallow that case silently. Any other CDP error propagates.
   */
  async dismissNativeDialog(
    tabId: number,
    accept: boolean,
    promptText: string
  ): Promise<void> {
    try {
      await (this.browser as any)['debugger'].sendCommand(
        { tabId },
        'Page.handleJavaScriptDialog',
        { accept, promptText: promptText || '' }
      );
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/no dialog is showing/i.test(msg)) return;
      throw e;
    }
  }

  /**
   * Unified handler for the `'dialog'` WS command. Dispatches behavior based
   * on whether `accept` was provided.
   *
   * - With `accept`: dismiss any live native dialog via CDP (unfreezes the
   *   renderer if the override missed), then re-inject the MAIN-world stubs
   *   with the new default, and return any events captured so far.
   * - Without `accept`: just drain and return the event log.
   *
   * The events array is included in both response shapes so the agent
   * always sees what dialogs fired during the call.
   * Order matters: dismiss MUST precede stub injection because a live native
   * dialog freezes the renderer and blocks `chrome.scripting.executeScript`.
   */
  async handleDialogCommand(
    tabId: number,
    params: { accept?: boolean; text?: string }
  ): Promise<{ events: DialogEvent[] }> {
    if (params.accept !== undefined) {
      const text = params.text || '';
      await this.dismissNativeDialog(tabId, params.accept, text);
      await this.setupDialogOverrides(tabId, params.accept, text);
    }
    const events = await this.drainDialogEvents(tabId);
    return { events };
  }

  /**
   * Start a background drain loop that polls `getDialogEvents` and buffers
   * them. Used to give the WS envelope hook (which must be synchronous) a
   * source of events without having to await per-call.
   *
   * Re-call with a new tabId to switch drain target without restarting the
   * interval — the most-recent tabId wins on the next tick.
   */
  startBuffering(tabId: number): void {
    this.drainTabId = tabId;
    if (this.drainInterval) return;
    this.drainInterval = setInterval(async () => {
      if (this.drainTabId == null) return;
      try {
        const events = await this.drainDialogEvents(this.drainTabId);
        if (events.length > 0) {
          this.eventBuffer.push(...events);
        }
      } catch { /* tab may be navigating; ignore */ }
    }, 500);
  }

  /** Stop buffering (e.g. on tab detach). */
  stopBuffering(): void {
    if (this.drainInterval) {
      clearInterval(this.drainInterval);
      this.drainInterval = null;
    }
    this.drainTabId = null;
  }

  /** Synchronously consume buffered events. Used by the WS envelope hook. */
  consumeBufferedEvents(): DialogEvent[] {
    if (this.eventBuffer.length === 0) return [];
    const out = this.eventBuffer;
    this.eventBuffer = [];
    return out;
  }

  /**
   * Atomic read-and-clear in a single MAIN-world execution. Prevents the
   * race where two consecutive drain ticks both read the same events
   * before the prior tick's clear lands.
   */
  async drainDialogEvents(tabId: number): Promise<DialogEvent[]> {
    try {
      const results = await this.browser.scripting.executeScript({
        target: { tabId },
        world: 'MAIN' as any,
        func: () => {
          const events = (window as any).__supersurfDialogEvents || [];
          (window as any).__supersurfDialogEvents = [];
          return events;
        },
      });
      return results?.[0]?.result || [];
    } catch {
      return [];
    }
  }

  /** Retrieve logged dialog events from the page for the given tab. */
  async getDialogEvents(tabId: number): Promise<DialogEvent[]> {
    try {
      const results = await this.browser.scripting.executeScript({
        target: { tabId },
        world: 'MAIN' as any,
        func: () => (window as any).__supersurfDialogEvents || [],
      });
      return results?.[0]?.result || [];
    } catch {
      return [];
    }
  }

  /** Reset the dialog event log for the given tab. */
  async clearDialogEvents(tabId: number): Promise<void> {
    try {
      await this.browser.scripting.executeScript({
        target: { tabId },
        world: 'MAIN' as any,
        func: () => { (window as any).__supersurfDialogEvents = []; },
      });
    } catch {
      // Ignore
    }
  }
}
