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
/**
 * Tracks the held native dialog PER TAB and resolves it through CDP.
 *
 * Only one JS dialog can be open per renderer — but this handler spans every
 * renderer in the profile, so a single slot let one agent's dialog overwrite
 * the record of another's. Keyed by tab id instead.
 */
export class DialogHandler {
    browser;
    logger;
    pending = new Map();
    constructor(browserAPI, logger) {
        this.browser = browserAPI;
        this.logger = logger;
    }
    /** Record a dialog that CDP just held open. Called from the debugger event listener. */
    onDialogOpening(tabId, params) {
        this.pending.set(tabId, {
            tabId,
            type: params.type,
            message: params.message ?? '',
            defaultPrompt: params.defaultPrompt ?? '',
            url: params.url ?? '',
            hasBrowserHandler: !!params.hasBrowserHandler,
            timestamp: Date.now(),
        });
        this.logger.log('[DialogHandler] held', tabId, params.type, JSON.stringify(params.message ?? ''));
    }
    /** The currently-held dialog for a tab, or null if none is open. */
    getPending(tabId) {
        return this.pending.get(tabId) ?? null;
    }
    /** Forget a tab's held dialog without touching CDP (used on detach / navigation). */
    clearPending(tabId) {
        this.pending.delete(tabId);
    }
    /**
     * Resolve the held dialog via CDP. `accept=true` clicks OK (and supplies
     * `promptText` for prompt dialogs); `accept=false` clicks Cancel. Unfreezes
     * the renderer. Always clears the pending slot, even when CDP reports no
     * dialog is showing (it may have been resolved by a navigation in between).
     */
    async handle(tabId, accept, promptText) {
        try {
            await this.browser['debugger'].sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept, promptText: promptText || '' });
        }
        catch (e) {
            const msg = String(e?.message || e);
            if (!/no dialog is showing/i.test(msg))
                throw e;
        }
        this.pending.delete(tabId);
    }
}
/**
 * Forget a tab's held dialog, and sweep that tab id out of every session's
 * `dialogPendingTabs`. Used when a tab's debugger detaches — that event names
 * a tab, not a session, and this must clear ONLY that tab: sessions holding a
 * dialog on some other tab are untouched.
 */
export function clearDialogForTab(dialogHandler, sessionContext, tabId) {
    dialogHandler.clearPending(tabId);
    for (const [, s] of sessionContext.sessionEntries())
        s.dialogPendingTabs.delete(tabId);
}
