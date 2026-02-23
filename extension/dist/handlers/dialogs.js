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
/**
 * Replaces `window.alert`, `window.confirm`, and `window.prompt` with
 * synchronous stubs that log events and return configurable responses.
 * This prevents dialogs from blocking page automation.
 */
export class DialogHandler {
    browser;
    logger;
    constructor(browserAPI, logger) {
        this.browser = browserAPI;
        this.logger = logger;
    }
    /**
     * Inject dialog overrides into the page's MAIN world.
     * @param tabId - Target tab
     * @param accept - Whether confirm() returns true and prompt() returns a value
     * @param promptText - Text returned by prompt() when accepted
     */
    async setupDialogOverrides(tabId, accept = true, promptText = '') {
        try {
            await this.browser.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: (shouldAccept, text) => {
                    if (!window.__supersurfDialogEvents) {
                        window.__supersurfDialogEvents = [];
                    }
                    window.alert = (msg) => {
                        window.__supersurfDialogEvents.push({
                            type: 'alert',
                            message: msg,
                            response: 'accepted',
                            timestamp: Date.now(),
                        });
                    };
                    window.confirm = (msg) => {
                        window.__supersurfDialogEvents.push({
                            type: 'confirm',
                            message: msg,
                            response: shouldAccept ? 'accepted' : 'dismissed',
                            timestamp: Date.now(),
                        });
                        return shouldAccept;
                    };
                    window.prompt = (msg, defaultValue) => {
                        const value = shouldAccept ? (text || defaultValue || '') : null;
                        window.__supersurfDialogEvents.push({
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
        }
        catch (e) {
            this.logger.log('[DialogHandler] Failed to inject:', e.message);
        }
    }
    /** Retrieve logged dialog events from the page for the given tab. */
    async getDialogEvents(tabId) {
        try {
            const results = await this.browser.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => window.__supersurfDialogEvents || [],
            });
            return results?.[0]?.result || [];
        }
        catch {
            return [];
        }
    }
    /** Reset the dialog event log for the given tab. */
    async clearDialogEvents(tabId) {
        try {
            await this.browser.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => { window.__supersurfDialogEvents = []; },
            });
        }
        catch {
            // Ignore
        }
    }
}
