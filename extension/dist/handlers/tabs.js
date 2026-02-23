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
            const allTabs = await this.browser.tabs.query({});
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
            return {
                id: tab.id,
                index: tab.index, // Chrome's real index, not filtered position
                title: tab.title || 'Untitled',
                url,
                automatable,
                attached: tab.id === this.ctx.attachedTabId,
                groupId: tab.groupId ?? -1,
                stealthMode: this.ctx.stealthTabs.get(tab.id) ?? null,
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
        // Session boundary enforcement
        if (params._sessionId) {
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
            // Session boundary enforcement
            if (params?._sessionId) {
                const ownership = this.getTabOwnership(tab, params._sessionId);
                if (ownership === 'other') {
                    throw new Error(`Tab belongs to another session's group. Cannot close.`);
                }
            }
            tabId = tab.id;
        }
        else if (this.ctx.attachedTabId) {
            tabId = this.ctx.attachedTabId;
        }
        else {
            throw new Error('No tab specified and no tab attached');
        }
        await this.browser.tabs.remove(tabId);
        this.handleTabClosed(tabId);
        return { success: true, message: `Tab closed` };
    }
    /** Clean up attachment state, stealth tracking, and tech stack info for a closed tab. */
    handleTabClosed(tabId) {
        if (tabId === this.ctx.attachedTabId) {
            this.ctx.attachedTabId = null;
            this.iconManager.setAttachedTab(null);
        }
        this.ctx.stealthTabs.delete(tabId);
        this.ctx.persistSession();
        this.techStackInfo.delete(tabId);
    }
}
