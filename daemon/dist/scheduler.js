"use strict";
/**
 * RequestScheduler — round-robin scheduler with tab ownership enforcement.
 *
 * Extracted from the multiplexer's leader-mode logic. Serializes all commands
 * to the extension through a single drain loop, ensuring fair round-robin
 * across sessions and automatic tab context-switching.
 *
 * @module scheduler
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestScheduler = void 0;
const debugLog = (...args) => {
    const logger = global.DAEMON_LOGGER;
    if (logger)
        logger.log('[Sched]', ...args);
    else if (global.DAEMON_DEBUG)
        console.error('[Sched]', ...args);
};
// Methods that modify tab ownership
const TAB_CLAIM_METHODS = new Set(['selectTab', 'createTab']);
const TAB_RELEASE_METHODS = new Set(['closeTab']);
// Methods where we need to ensure the correct tab is active before executing
const TAB_SCOPED_METHODS = new Set([
    'navigate', 'snapshot', 'evaluate', 'screenshot',
    'consoleMessages', 'networkRequests', 'clearNetwork',
    'performanceMetrics', 'waitForReady', 'capturePageState',
    'forwardCDPCommand', 'window', 'dialog',
    'listExtensions', 'reloadExtension', 'secure_fill',
]);
/**
 * Round-robin request scheduler with tab ownership and auto context-switching.
 */
class RequestScheduler {
    bridge;
    sessions;
    requestQueue = new Map();
    sessionOrder = [];
    currentSessionIdx = 0;
    processingQueue = false;
    /** Current extension tab per profile (null key = unmanaged). */
    currentExtensionTabIds = new Map();
    sessionGroupIds = new Map();
    constructor(bridge, sessions) {
        this.bridge = bridge;
        this.sessions = sessions;
    }
    /** Get the current extension tab ID for a given profile context. */
    getCurrentTabId(profileId) {
        return this.currentExtensionTabIds.get(profileId) ?? null;
    }
    /** Set the current extension tab ID for a given profile context. */
    setCurrentTabId(profileId, tabId) {
        this.currentExtensionTabIds.set(profileId, tabId);
    }
    /** Register a session in the scheduler. */
    addSession(sessionId) {
        this.requestQueue.set(sessionId, []);
        this.sessionOrder.push(sessionId);
    }
    /** Remove a session from the scheduler. Rejects queued requests. */
    removeSession(sessionId) {
        const queued = this.requestQueue.get(sessionId) || [];
        for (const req of queued) {
            req.reject(new Error('Session disconnected'));
        }
        this.requestQueue.delete(sessionId);
        this.sessionOrder = this.sessionOrder.filter(s => s !== sessionId);
        this.sessionGroupIds.delete(sessionId);
        if (this.currentSessionIdx >= this.sessionOrder.length) {
            this.currentSessionIdx = 0;
        }
    }
    /** Enqueue a request and return a promise for the result. */
    enqueue(sessionId, method, params, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const queue = this.requestQueue.get(sessionId);
            if (!queue) {
                reject(new Error('Unknown session'));
                return;
            }
            queue.push({ sessionId, method, params, timeout, resolve, reject });
            this.drainQueue();
        });
    }
    /** Process queued requests in round-robin order. Serialized — one at a time. */
    async drainQueue() {
        if (this.processingQueue)
            return;
        this.processingQueue = true;
        try {
            while (this.hasQueuedRequests()) {
                const request = this.pickNextRequest();
                if (!request)
                    break;
                await this.executeRequest(request);
            }
        }
        finally {
            this.processingQueue = false;
        }
    }
    hasQueuedRequests() {
        for (const queue of this.requestQueue.values()) {
            if (queue.length > 0)
                return true;
        }
        return false;
    }
    /** Round-robin pick: advance through sessions, skip empty queues. */
    pickNextRequest() {
        if (this.sessionOrder.length === 0)
            return null;
        let checked = 0;
        while (checked < this.sessionOrder.length) {
            const sessionId = this.sessionOrder[this.currentSessionIdx];
            const queue = this.requestQueue.get(sessionId);
            this.currentSessionIdx = (this.currentSessionIdx + 1) % this.sessionOrder.length;
            checked++;
            if (queue && queue.length > 0) {
                return queue.shift();
            }
        }
        return null;
    }
    /**
     * Execute a single queued request:
     * 1. Tab ownership check for tab-management methods
     * 2. Auto context-switch if this session's tab != current extension tab
     * 3. Inject _sessionId for extension-side group isolation
     * 4. Execute the actual command
     * 5. Track ownership changes
     */
    async executeRequest(request) {
        const { sessionId, method, params, timeout, resolve, reject } = request;
        try {
            // Tab ownership enforcement
            if (TAB_CLAIM_METHODS.has(method)) {
                if (method === 'selectTab') {
                    const tabId = params.tabId;
                    if (tabId !== undefined) {
                        const owner = this.sessions.findTabOwner(tabId);
                        if (owner && owner !== sessionId) {
                            reject(new Error(`Tab ${tabId} is owned by session "${owner}". Cannot attach.`));
                            return;
                        }
                    }
                }
            }
            if (TAB_RELEASE_METHODS.has(method)) {
                const tabId = params.tabId;
                if (tabId !== undefined) {
                    const owner = this.sessions.findTabOwner(tabId);
                    if (owner && owner !== sessionId) {
                        reject(new Error(`Tab ${tabId} is owned by session "${owner}". Cannot close.`));
                        return;
                    }
                }
            }
            // Determine profile context for this session
            const profileId = this.sessions.getProfileId(sessionId);
            const currentTabId = this.getCurrentTabId(profileId);
            // Auto context-switch
            if (TAB_SCOPED_METHODS.has(method) || (!TAB_CLAIM_METHODS.has(method) && !TAB_RELEASE_METHODS.has(method) && method !== 'getTabs')) {
                const sessionTabId = this.sessions.getAttachedTabId(sessionId);
                if (sessionTabId !== null && sessionTabId !== currentTabId) {
                    debugLog(`Context-switch: tab ${currentTabId} -> ${sessionTabId} (session="${sessionId}", profile=${profileId || 'unmanaged'})`);
                    try {
                        const switchCmd = profileId
                            ? this.bridge.sendCmdToProfile(profileId, 'selectTab', { tabId: sessionTabId, _sessionId: sessionId }, 5000)
                            : this.bridge.sendCmd('selectTab', { tabId: sessionTabId, _sessionId: sessionId }, 5000);
                        await switchCmd;
                        this.setCurrentTabId(profileId, sessionTabId);
                    }
                    catch (err) {
                        debugLog(`Context-switch failed: ${err.message}`);
                    }
                }
            }
            // Inject _sessionId for extension-side group isolation
            const enrichedParams = { ...params, _sessionId: sessionId };
            // Execute the actual command — route to profile connection or unmanaged
            const result = profileId
                ? await this.bridge.sendCmdToProfile(profileId, method, enrichedParams, timeout)
                : await this.bridge.sendCmd(method, enrichedParams, timeout);
            // Track ownership changes
            if (method === 'createTab' || method === 'selectTab') {
                const tabId = result?.attachedTab?.id ?? result?.id;
                const groupId = result?.attachedTab?.groupId;
                if (tabId) {
                    this.sessions.addOwnedTab(sessionId, tabId);
                    this.sessions.setAttachedTabId(sessionId, tabId);
                    this.setCurrentTabId(profileId, tabId);
                }
                if (groupId !== undefined && groupId !== -1) {
                    this.sessionGroupIds.set(sessionId, groupId);
                    this.sessions.setGroupId(sessionId, groupId);
                }
            }
            if (method === 'closeTab') {
                const sessionTabId = this.sessions.getAttachedTabId(sessionId);
                if (sessionTabId !== null) {
                    this.sessions.removeOwnedTab(sessionId, sessionTabId);
                    this.sessions.setAttachedTabId(sessionId, null);
                }
            }
            // Filter getTabs results
            if (method === 'getTabs') {
                const tabsResult = result?.tabs ?? result;
                if (Array.isArray(tabsResult)) {
                    const otherOwnedIds = this.sessions.getOtherOwnedTabIds(sessionId);
                    const filtered = tabsResult.filter((tab) => !otherOwnedIds.has(tab.id));
                    if (result?.tabs) {
                        resolve({ ...result, tabs: filtered });
                    }
                    else {
                        resolve(filtered);
                    }
                    return;
                }
            }
            resolve(result);
        }
        catch (error) {
            reject(error);
        }
    }
    /** Return total number of queued requests across all sessions. */
    getQueueDepth() {
        let count = 0;
        for (const queue of this.requestQueue.values()) {
            count += queue.length;
        }
        return count;
    }
    /** Drain and reject all queued requests. Called during shutdown. */
    drainAll() {
        for (const [, queue] of this.requestQueue) {
            for (const req of queue) {
                req.reject(new Error('Daemon shutting down'));
            }
        }
        this.requestQueue.clear();
        this.sessionOrder = [];
    }
}
exports.RequestScheduler = RequestScheduler;
//# sourceMappingURL=scheduler.js.map