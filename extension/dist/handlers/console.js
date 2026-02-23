/**
 * @module handlers/console
 *
 * Captures `console.*` output from automated pages by injecting a MAIN-world
 * script that monkey-patches console methods. Messages are relayed to the
 * service worker via `window.postMessage` -> content script -> `runtime.sendMessage`.
 *
 * Key exports:
 * - {@link ConsoleHandler} — message buffer + injection logic
 *
 * Adapted from Blueprint MCP (Apache 2.0)
 */
/** Maximum buffered messages before oldest are dropped (FIFO). */
const MAX_MESSAGES = 1000;
/**
 * Buffers console messages captured from automated pages.
 * Injection is idempotent per tab (guarded by `__supersurfConsoleInjected`).
 */
export class ConsoleHandler {
    browser;
    logger;
    messages = [];
    constructor(browserAPI, logger) {
        this.browser = browserAPI;
        this.logger = logger;
    }
    /** Listen for forwarded console messages from the content script relay. */
    setupMessageListener() {
        this.browser.runtime.onMessage.addListener((message, sender) => {
            if (message.type === 'console') {
                this.addMessage({
                    level: message.level,
                    text: message.text,
                    timestamp: message.timestamp || Date.now(),
                    tabId: sender.tab?.id,
                });
            }
        });
    }
    /**
     * Inject a MAIN-world script that wraps console.log/warn/error/info/debug.
     * Each call serializes args and posts them via `window.postMessage`, which
     * the content script forwards to the service worker.
     * @param tabId - Tab to inject into
     */
    async injectConsoleCapture(tabId) {
        try {
            await this.browser.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => {
                    if (window.__supersurfConsoleInjected)
                        return;
                    window.__supersurfConsoleInjected = true;
                    const original = {
                        log: console.log.bind(console),
                        warn: console.warn.bind(console),
                        error: console.error.bind(console),
                        info: console.info.bind(console),
                        debug: console.debug.bind(console),
                    };
                    const levels = ['log', 'warn', 'error', 'info', 'debug'];
                    for (const level of levels) {
                        console[level] = (...args) => {
                            original[level](...args);
                            try {
                                const text = args
                                    .map((a) => {
                                    if (typeof a === 'object') {
                                        try {
                                            return JSON.stringify(a);
                                        }
                                        catch {
                                            return String(a);
                                        }
                                    }
                                    return String(a);
                                })
                                    .join(' ');
                                window.postMessage({ __supersurfConsole: { level, text, timestamp: Date.now() } }, '*');
                            }
                            catch {
                                // Ignore serialization errors
                            }
                        };
                    }
                },
            });
        }
        catch (e) {
            this.logger.log('[ConsoleHandler] Failed to inject:', e.message);
        }
    }
    /** Append a message, evicting the oldest if at capacity. */
    addMessage(msg) {
        if (this.messages.length >= MAX_MESSAGES) {
            this.messages.shift();
        }
        this.messages.push(msg);
    }
    /** Retrieve messages, optionally filtered to a specific tab. Returns a copy. */
    getMessages(tabId) {
        if (tabId !== undefined) {
            return this.messages.filter((m) => m.tabId === tabId);
        }
        return [...this.messages];
    }
    clearMessages() {
        this.messages = [];
    }
}
