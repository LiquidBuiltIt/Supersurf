/**
 * @module utils/logger
 *
 * Conditional debug logging for the extension. Output is suppressed unless
 * debug mode is enabled in `chrome.storage.local`. Automatically reacts to
 * storage changes so toggling debug mode takes effect without reload.
 *
 * Key exports:
 * - {@link Logger} — prefixed logger with debug/always/error/warn levels
 *
 * Adapted from Blueprint MCP (Apache 2.0)
 */
/**
 * Prefixed logger that gates output on a debug mode flag stored in
 * `chrome.storage.local`. Use {@link log} for debug-only output and
 * {@link logAlways} for messages that should always appear.
 */
export class Logger {
    prefix;
    debugMode = false;
    browser = null;
    constructor(prefix) {
        this.prefix = prefix;
    }
    /** Read initial debug mode from storage and subscribe to future changes. */
    async init(browserAPI) {
        this.browser = browserAPI;
        const result = await browserAPI.storage.local.get(['debugMode']);
        this.debugMode = result.debugMode === true;
        browserAPI.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local' && changes.debugMode) {
                this.debugMode = changes.debugMode.newValue === true;
            }
        });
    }
    timestamp() {
        const d = new Date();
        return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
    }
    /** Log only when debug mode is enabled. */
    log(...args) {
        if (this.debugMode) {
            console.log(`[${this.prefix}] ${this.timestamp()}`, ...args);
        }
    }
    /** Log regardless of debug mode (for critical lifecycle events). */
    logAlways(...args) {
        console.log(`[${this.prefix}] ${this.timestamp()}`, ...args);
    }
    error(...args) {
        console.error(`[${this.prefix}] ${this.timestamp()}`, ...args);
    }
    warn(...args) {
        console.warn(`[${this.prefix}] ${this.timestamp()}`, ...args);
    }
    /** Programmatically override debug mode (e.g. from a test harness). */
    setDebugMode(enabled) {
        this.debugMode = enabled;
    }
}
