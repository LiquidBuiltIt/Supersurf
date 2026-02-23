/**
 * @module experimental/index
 *
 * Entry point for the extension's experimental feature subsystem.
 * Registers WebSocket command handlers for `capturePageState` and `waitForReady`
 * (smart waiting), keeping experimental logic isolated from the stable handler set.
 *
 * Key exports:
 * - {@link ExperimentalFeatures} — static registration class
 */
import { capturePageState } from './capture-page-state.js';
import { waitForDOMStable } from './wait-for-ready.js';
/**
 * Registers experimental command handlers on the WebSocket connection.
 * All methods are static — no instance state needed.
 */
export class ExperimentalFeatures {
    /**
     * Wire up `capturePageState` and `waitForReady` commands.
     * @param wsConnection - WebSocket connection to register handlers on
     * @param tabHandlers - Provides the currently attached tab ID
     * @param networkTracker - Used by waitForReady to detect network idle
     * @param sessionContext - Session state (unused directly but available for future experiments)
     */
    static registerHandlers(wsConnection, tabHandlers, networkTracker, sessionContext) {
        // capturePageState — injects DOM capture into the page, returns PageState
        wsConnection.registerCommandHandler('capturePageState', async () => {
            const tabId = tabHandlers.getAttachedTabId();
            if (!tabId)
                throw new Error('No tab attached');
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: capturePageState,
            });
            if (!results?.[0]?.result) {
                throw new Error('Failed to capture page state');
            }
            return results[0].result;
        });
        // waitForReady — races DOM stability + network idle against an overall timeout.
        // The 500ms initial delay gives the DOM time to start mutating after navigation.
        wsConnection.registerCommandHandler('waitForReady', async (params) => {
            const tabId = tabHandlers.getAttachedTabId();
            if (!tabId)
                throw new Error('No tab attached');
            const timeout = params?.timeout || 10000;
            const stabilityMs = params?.stabilityMs || 300;
            const start = Date.now();
            // Minimum wait before checking — DOM needs time to start mutating after navigation
            await new Promise(r => setTimeout(r, 500));
            // DOM stability via injected script
            const domStablePromise = chrome.scripting.executeScript({
                target: { tabId },
                func: waitForDOMStable,
                args: [stabilityMs],
            });
            // Network idle polling
            const networkIdlePromise = pollNetworkIdle(networkTracker, 500, timeout);
            // Race: both signals vs overall timeout
            await Promise.race([
                Promise.all([domStablePromise, networkIdlePromise]),
                new Promise(resolve => setTimeout(resolve, timeout)),
            ]);
            return { ready: true, elapsed: Date.now() - start };
        });
    }
}
/**
 * Poll networkTracker for 0 pending requests over idleMs.
 * A request is "pending" if it has no statusCode and no error.
 */
function pollNetworkIdle(tracker, idleMs, timeout) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let idleSince = null;
        const interval = setInterval(() => {
            const requests = tracker.getRequests();
            const pending = requests.filter(r => !r.statusCode && !r.error);
            if (pending.length === 0) {
                if (idleSince === null) {
                    idleSince = Date.now();
                }
                else if (Date.now() - idleSince >= idleMs) {
                    clearInterval(interval);
                    resolve();
                }
            }
            else {
                idleSince = null;
            }
            if (Date.now() - startTime >= timeout) {
                clearInterval(interval);
                resolve(); // Resolve on timeout — don't block forever
            }
        }, 100);
    });
}
