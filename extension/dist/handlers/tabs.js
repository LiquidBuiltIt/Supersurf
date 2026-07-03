/**
 * @module handlers/tabs
 *
 * Tab lifecycle management: create, select, close, and list browser tabs.
 * Tracks per-tab metadata (stealth mode, tech stack) and enforces session
 * isolation via Chrome tab groups in multi-client mode.
 *
 * Key exports:
 * - {@link TabHandlers} — main class registered by background.ts
 *
 * Adapted from Blueprint MCP (Apache 2.0)
 */
/** Rotating palette for session tab groups — each session gets the next color. */
const GROUP_COLORS = [
    'blue', 'red', 'green', 'yellow', 'purple', 'cyan', 'pink', 'orange', 'grey',
];
/**
 * Manages browser tab CRUD, attaching/detaching, stealth mode tracking,
 * tech stack metadata, and per-session tab group isolation.
 *
 * Injectors for console capture and dialog overrides are set post-construction
 * to avoid circular dependency with those handler classes.
 */
export class TabHandlers {
    browser;
    logger;
    iconManager;
    ctx;
    techStackInfo = new Map();
    // Session → tab group isolation
    sessionGroups = new Map(); // sessionId → Chrome groupId
    groupSessions = new Map(); // groupId → sessionId (reverse)
    colorIndex = 0;
    consoleInjector = null;
    dialogInjector = null;
    /**
     * Transient per-command recovery note. Set by ensureAttachedTab() when
     * recovery fires, consumed by the websocket layer after the command
     * handler returns so the note can be attached to the response envelope.
     * Single-slot buffer — handlers run serially per session.
     */
    _lastRecoveryNote = null;
    constructor(browserAPI, logger, iconManager, sessionContext) {
        this.browser = browserAPI;
        this.logger = logger;
        this.iconManager = iconManager;
        this.ctx = sessionContext;
        // Listen for tab close
        this.browser.tabs.onRemoved.addListener((tabId) => this.handleTabClosed(tabId));
        // Clean up session→group maps if a group is removed externally
        this.browser.tabGroups.onRemoved.addListener((group) => this.handleGroupRemoved(group.id));
    }
    /** Register a callback that injects console capture into newly attached tabs. */
    setConsoleInjector(fn) {
        this.consoleInjector = fn;
    }
    /** Register a callback that injects dialog overrides into newly attached tabs. */
    setDialogInjector(fn) {
        this.dialogInjector = fn;
    }
    /** Returns the currently attached tab ID, or null if no tab is attached. */
    getAttachedTabId() {
        return this.ctx.attachedTabId;
    }
    /**
     * Resolve the current attached tab, recovering if it is null or stale.
     *
     * Recovery order:
     *   1. If `attachedTabId` is set AND `chrome.tabs.get` succeeds, return as-is.
     *   2. Otherwise (null or stale), pick the most recently active visible
     *      automatable tab — preferring tabs in the current focused window.
     *   3. If no candidates exist, throw with a clear error.
     *
     * On recovery, updates sessionContext + icon manager and logs the event
     * so audit analysis can see it happened.
     *
     * @returns `{ tabId, recovery? }` — `recovery` is undefined when no recovery was needed.
     */
    async ensureAttachedTab(explicitTabId) {
        // Explicit override (concurrency isolation): a caller that pins a tabId
        // acts on exactly that tab. Verify it's alive and return it WITHOUT
        // mutating the shared `attachedTabId` global — otherwise one caller's
        // explicit target would flip a concurrent caller's view of "the" tab,
        // which is the exact race this override exists to prevent.
        if (explicitTabId != null) {
            await this.browser.tabs.get(explicitTabId); // throws → clear error if the tab is gone
            return { tabId: explicitTabId };
        }
        const previousTabId = this.ctx.attachedTabId;
        // Path 1: attached tab exists — verify it is still alive
        if (previousTabId !== null) {
            try {
                await this.browser.tabs.get(previousTabId);
                return { tabId: previousTabId };
            }
            catch {
                // Stale — fall through to recovery
                this.ctx.attachedTabId = null;
                this.iconManager.setAttachedTab(null);
            }
        }
        const reason = previousTabId === null ? 'no-attached-tab' : 'stale-attached-tab';
        // Find a recovery candidate
        const allTabs = await this.browser.tabs.query({});
        const candidates = allTabs.filter((t) => {
            if (!t.id || !t.url)
                return false;
            if (t.url.startsWith('chrome://'))
                return false;
            if (t.url.startsWith('chrome-extension://'))
                return false;
            if (t.url.startsWith('about:'))
                return false;
            return true;
        });
        if (candidates.length === 0) {
            throw new Error(`No attached tab and no recoverable tabs available. Open a tab or call browser_tabs with action="new" to create one.`);
        }
        // Determine the preferred window (current focused window if available)
        let preferredWindowId;
        try {
            const win = await this.browser.windows.getCurrent();
            preferredWindowId = win?.id;
        }
        catch {
            // windows API not available (e.g. in tests) — skip preference
        }
        // Preference order:
        //   (a) active tab in preferred window
        //   (b) any active tab
        //   (c) any candidate (last in list — typically most-recently opened)
        let target;
        if (preferredWindowId !== undefined) {
            target = candidates.find((t) => t.active && t.windowId === preferredWindowId);
        }
        if (!target)
            target = candidates.find((t) => t.active);
        if (!target)
            target = candidates[candidates.length - 1];
        this.ctx.attachedTabId = target.id;
        this.ctx.persistSession();
        this.iconManager.setAttachedTab(target.id);
        this.logger.log(`[TabHandlers] Tab recovery (${reason}): previous=${previousTabId} → new=${target.id} (${target.url})`);
        const recovery = {
            reason,
            previousTabId,
            newTabId: target.id,
            url: target.url || '',
        };
        this._lastRecoveryNote = recovery;
        return { tabId: target.id, recovery };
    }
    /**
     * Consume and clear the last recovery note. Called by the websocket layer
     * after a command handler returns so it can attach the note to the
     * response envelope. Returns null if no recovery happened this call.
     */
    consumeRecoveryNote() {
        const note = this._lastRecoveryNote;
        this._lastRecoveryNote = null;
        return note;
    }
    /** Reset the recovery-note buffer before a command runs. */
    clearRecoveryNote() {
        this._lastRecoveryNote = null;
    }
    /** Store framework/library detection results reported by the content script. */
    setTechStackInfo(tabId, techStack) {
        this.techStackInfo.set(tabId, techStack);
    }
    // ─── Tab Group Management ──────────────────────────────────────
    /**
     * Assign a tab to a session's group. Creates the group lazily on first tab.
     */
    async assignTabToGroup(tabId, sessionId) {
        const existingGroupId = this.sessionGroups.get(sessionId);
        if (existingGroupId !== undefined) {
            // Add to existing group
            await this.browser.tabs.group({ tabIds: [tabId], groupId: existingGroupId });
            return existingGroupId;
        }
        // Create new group with this tab
        const groupId = await this.browser.tabs.group({ tabIds: [tabId] });
        const color = GROUP_COLORS[this.colorIndex % GROUP_COLORS.length];
        this.colorIndex++;
        await this.browser.tabGroups.update(groupId, { title: sessionId, color });
        this.sessionGroups.set(sessionId, groupId);
        this.groupSessions.set(groupId, sessionId);
        this.logger.log(`Created tab group ${groupId} (${color}) for session "${sessionId}"`);
        return groupId;
    }
    /**
     * Check if a tab belongs to a specific session's group, is ungrouped, or belongs to another session.
     * Returns 'own' | 'ungrouped' | 'other'.
     */
    getTabOwnership(tab, sessionId) {
        const groupId = tab.groupId ?? -1;
        if (groupId === -1)
            return 'ungrouped';
        const sessionGroupId = this.sessionGroups.get(sessionId);
        if (sessionGroupId !== undefined && groupId === sessionGroupId)
            return 'own';
        // Check if it belongs to any known session
        if (this.groupSessions.has(groupId))
            return 'other';
        // Unknown group (user-created) — treat as ungrouped
        return 'ungrouped';
    }
    handleGroupRemoved(groupId) {
        const sessionId = this.groupSessions.get(groupId);
        if (sessionId) {
            this.groupSessions.delete(groupId);
            this.sessionGroups.delete(sessionId);
            this.logger.log(`Tab group ${groupId} removed — cleared session "${sessionId}" mapping`);
        }
    }
    /**
     * Called when a session disconnects. Ungroups its tabs so they become available again.
     */
    async handleSessionDisconnect(sessionId) {
        const groupId = this.sessionGroups.get(sessionId);
        if (groupId === undefined) {
            return { success: true, message: `No tab group for session "${sessionId}"` };
        }
        // Find all tabs in this group and ungroup them
        try {
            const allTabs = await this.browser.tabs.query({ windowType: 'normal' });
            const groupTabIds = allTabs
                .filter(t => (t.groupId ?? -1) === groupId)
                .map(t => t.id)
                .filter(Boolean);
            if (groupTabIds.length > 0) {
                await this.browser.tabs.ungroup(groupTabIds);
            }
        }
        catch (err) {
            this.logger.log(`Error ungrouping tabs for session "${sessionId}":`, err);
        }
        this.sessionGroups.delete(sessionId);
        this.groupSessions.delete(groupId);
        this.logger.log(`Session "${sessionId}" disconnected — ungrouped tabs from group ${groupId}`);
        return { success: true, message: `Ungrouped tabs for session "${sessionId}"` };
    }
    // ─── Core Tab Operations ───────────────────────────────────────
    /**
     * List all visible tabs. In multi-session mode, filters out tabs belonging
     * to other sessions' groups while showing own + ungrouped tabs.
     */
    async getTabs(params) {
        const allTabs = await this.browser.tabs.query({});
        const sessionId = params?._sessionId;
        // Resolve window types for all tabs
        const windowCache = new Map();
        for (const tab of allTabs) {
            if (tab.windowId && !windowCache.has(tab.windowId)) {
                try {
                    const win = await this.browser.windows.get(tab.windowId);
                    windowCache.set(tab.windowId, win.type || 'normal');
                }
                catch {
                    windowCache.set(tab.windowId, 'normal');
                }
            }
        }
        const tabs = allTabs
            .filter((tab) => {
            // No session filtering in single-client mode
            if (!sessionId)
                return true;
            const ownership = this.getTabOwnership(tab, sessionId);
            // Show own tabs + ungrouped tabs; hide other sessions' tabs
            return ownership !== 'other';
        })
            .map((tab, idx) => {
            const url = tab.url || '';
            const automatable = !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('about:');
            const windowType = windowCache.get(tab.windowId) || 'normal';
            return {
                id: tab.id,
                index: tab.index,
                title: tab.title || 'Untitled',
                url,
                automatable,
                attached: tab.id === this.ctx.attachedTabId,
                groupId: tab.groupId ?? -1,
                stealthMode: this.ctx.stealthTabs.get(tab.id) ?? null,
                windowType,
                techStack: this.techStackInfo.get(tab.id) || null,
            };
        });
        return { tabs, attachedTabId: this.ctx.attachedTabId };
    }
    /**
     * Create a new tab, auto-attach it, assign to the session's tab group,
     * and inject console/dialog handlers.
     */
    async createTab(params) {
        const url = params.url || 'about:blank';
        const activate = params.activate !== false;
        const stealth = params.stealth || false;
        const tab = await this.browser.tabs.create({ url, active: activate });
        this.ctx.attachedTabId = tab.id;
        this.ctx.stealthMode = stealth;
        this.ctx.stealthTabs.set(tab.id, stealth);
        this.ctx.persistSession();
        this.iconManager.setAttachedTab(tab.id);
        this.iconManager.setStealthMode(stealth);
        // Assign to session's tab group
        let groupId;
        if (params._sessionId) {
            groupId = await this.assignTabToGroup(tab.id, params._sessionId);
        }
        // Inject console/dialog handlers
        if (this.consoleInjector)
            await this.consoleInjector(tab.id).catch(() => { });
        if (this.dialogInjector)
            await this.dialogInjector(tab.id).catch(() => { });
        return {
            attachedTab: {
                id: tab.id,
                index: tab.index,
                title: tab.title || 'Untitled',
                url: tab.url || url,
                groupId: groupId ?? (tab.groupId ?? -1),
            },
            stealthMode: stealth,
        };
    }
    /**
     * Attach to an existing tab by index or ID. Enforces session boundaries:
     * tabs owned by another session cannot be selected. Ungrouped tabs are
     * claimed by adding them to the requesting session's group.
     */
    async selectTab(params) {
        let tab;
        if (params.tabId !== undefined) {
            // ID-based selection (used by multiplexer context-switching)
            tab = await this.browser.tabs.get(params.tabId);
        }
        else if (params.index !== undefined) {
            // Index-based selection (backwards-compat for single-client)
            const allTabs = await this.browser.tabs.query({});
            if (params.index < 0 || params.index >= allTabs.length) {
                throw new Error(`Tab index ${params.index} out of range (0-${allTabs.length - 1})`);
            }
            tab = allTabs[params.index];
        }
        else {
            throw new Error('Either tabId or index is required');
        }
        const url = tab.url || '';
        if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
            throw new Error(`Cannot automate ${url} — Chrome internal pages are not accessible.`);
        }
        // Determine if this tab is in a normal window (grouping only works on normal windows)
        let isNormalWindow = true;
        try {
            const win = await this.browser.windows.get(tab.windowId);
            isNormalWindow = win.type === 'normal';
        }
        catch { }
        // Session boundary enforcement — skip grouping for popup windows
        if (params._sessionId && isNormalWindow) {
            const ownership = this.getTabOwnership(tab, params._sessionId);
            if (ownership === 'other') {
                throw new Error(`Tab belongs to another session's group. Cannot attach.`);
            }
            // Claim ungrouped tab by adding to session's group
            if (ownership === 'ungrouped') {
                await this.assignTabToGroup(tab.id, params._sessionId);
            }
        }
        const stealth = params.stealth ?? this.ctx.stealthTabs.get(tab.id) ?? false;
        this.ctx.attachedTabId = tab.id;
        this.ctx.stealthMode = stealth;
        this.ctx.stealthTabs.set(tab.id, stealth);
        this.ctx.persistSession();
        this.iconManager.setAttachedTab(tab.id);
        this.iconManager.setStealthMode(stealth);
        if (params.activate !== false) {
            await this.browser.tabs.update(tab.id, { active: true });
        }
        // Inject handlers
        if (this.consoleInjector)
            await this.consoleInjector(tab.id).catch(() => { });
        if (this.dialogInjector)
            await this.dialogInjector(tab.id).catch(() => { });
        return {
            attachedTab: {
                id: tab.id,
                index: tab.index,
                title: tab.title || 'Untitled',
                url,
                groupId: tab.groupId ?? -1,
                techStack: this.techStackInfo.get(tab.id) || null,
            },
            stealthMode: stealth,
        };
    }
    /** Close a tab by index, or close the currently attached tab if no index given. */
    async closeTab(params) {
        const index = params?.index;
        let tabId;
        if (index !== undefined) {
            const allTabs = await this.browser.tabs.query({});
            if (index < 0 || index >= allTabs.length) {
                throw new Error(`Tab index ${index} out of range`);
            }
            const tab = allTabs[index];
            // Session boundary enforcement — only for normal windows (popups can't be grouped)
            if (params?._sessionId) {
                let isNormalWindow = true;
                try {
                    const win = await this.browser.windows.get(tab.windowId);
                    isNormalWindow = win.type === 'normal';
                }
                catch { }
                if (isNormalWindow) {
                    const ownership = this.getTabOwnership(tab, params._sessionId);
                    if (ownership === 'other') {
                        throw new Error(`Tab belongs to another session's group. Cannot close.`);
                    }
                }
            }
            tabId = tab.id;
        }
        else if (this.ctx.attachedTabId) {
            tabId = this.ctx.attachedTabId;
        }
        else {
            const available = await this.browser.tabs.query({ windowType: 'normal' });
            const count = available.length;
            throw new Error(`No tab specified and no tab attached. ${count} tab${count !== 1 ? 's' : ''} available — use selectTab first or pass an index.`);
        }
        await this.browser.tabs.remove(tabId);
        this.handleTabClosed(tabId);
        return { success: true, message: `Tab closed` };
    }
    /** Clean up attachment state, stealth tracking, and tech stack info for a closed tab. */
    handleTabClosed(tabId) {
        const wasAttached = tabId === this.ctx.attachedTabId;
        if (wasAttached) {
            this.ctx.attachedTabId = null;
            this.iconManager.setAttachedTab(null);
        }
        this.ctx.stealthTabs.delete(tabId);
        this.ctx.persistSession();
        this.techStackInfo.delete(tabId);
        // Auto-reattach to another tab if the attached tab was closed
        if (wasAttached) {
            this.autoReattach().catch(() => { });
        }
    }
    /**
     * Attempt to reattach to the most recent normal-window tab after the
     * attached tab is closed. Silently does nothing if no candidates exist.
     */
    async autoReattach() {
        try {
            const allTabs = await this.browser.tabs.query({ windowType: 'normal' });
            // Filter to automatable tabs (not chrome://, not chrome-extension://)
            const candidates = allTabs.filter(t => t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
            if (candidates.length === 0)
                return;
            // Prefer the currently active tab, otherwise take the last one
            const active = candidates.find(t => t.active);
            const target = active || candidates[candidates.length - 1];
            this.ctx.attachedTabId = target.id;
            this.ctx.persistSession();
            this.iconManager.setAttachedTab(target.id);
            this.logger.log(`Auto-reattached to tab ${target.id} (${target.url})`);
        }
        catch {
            // Best-effort — don't break the close flow
        }
    }
}
