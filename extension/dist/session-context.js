/**
 * SessionContext — centralized extension state management.
 * Replaces fragmented state scattered across TabHandlers, IconManager, and background.ts.
 * Supports per-session state for multiplexer compatibility.
 *
 * State persistence: critical and important state is written through to
 * chrome.storage.session on every mutation, surviving service worker
 * suspension without requiring a browser restart. Storage is cleared
 * on disable/disconnect to prevent unbounded growth across sessions.
 */
const STORAGE_KEY = '__supersurf_session_state';
/** Factory for a fresh session state with safe defaults. */
function createSessionState() {
    return {
        attachedTabId: null,
        stealthMode: false,
        stealthTabs: new Map(),
        cursorPositions: new Map(),
        humanizationConfig: { enabled: false },
        dialogPendingTabs: new Set(),
    };
}
function serializeSession(s) {
    return {
        attachedTabId: s.attachedTabId,
        stealthMode: s.stealthMode,
        stealthTabs: Array.from(s.stealthTabs.entries()),
        cursorPositions: Array.from(s.cursorPositions.entries()),
        humanizationConfig: { ...s.humanizationConfig },
    };
}
function deserializeSession(s) {
    return {
        attachedTabId: s.attachedTabId,
        stealthMode: s.stealthMode,
        stealthTabs: new Map(s.stealthTabs || []),
        cursorPositions: new Map(s.cursorPositions || []),
        humanizationConfig: s.humanizationConfig || { enabled: false },
        // Not persisted — see the field's doc comment on SessionState.
        dialogPendingTabs: new Set(),
    };
}
/**
 * Centralized extension state management with multiplexer support.
 *
 * Replaces fragmented state that was previously scattered across TabHandlers,
 * IconManager, and background.ts. Supports both single-client mode (null key)
 * and multi-session mode where each MCP client gets isolated state.
 *
 * State is written through to chrome.storage.session on every mutation
 * so it survives MV3 service worker suspension cycles.
 *
 * There are no no-arg convenience accessors — callers must go through
 * `getSession(sessionId)` so the compiler names anyone who forgets which
 * session they're acting for.
 */
export class SessionContext {
    /** Whether the WebSocket connection to the MCP server is active. */
    _connected = false;
    /** Tabs the CDP debugger is currently attached to. Chrome allows several at
     *  once; the previous single-tab global made agent B's screenshot detach
     *  agent A's tab and silently kill A's network capture. */
    _attachedDebuggerTabs = new Set();
    // Per-session state. null key = single-client mode (backwards compat).
    sessions = new Map();
    /** Reference to chrome.storage.session for persistence. */
    storage = null;
    /**
     * Initialize persistence layer. Must be called before use in background.ts.
     * Safe to skip in tests or environments without chrome.storage.session.
     */
    async init(chromeRef) {
        const storageSession = chromeRef?.storage?.session;
        if (!storageSession)
            return;
        this.storage = storageSession;
        await this.rehydrate();
    }
    // ── Persisted top-level properties with write-through ──
    get connected() { return this._connected; }
    set connected(value) {
        this._connected = value;
        this.persist();
    }
    isDebuggerAttached(tabId) { return this._attachedDebuggerTabs.has(tabId); }
    markDebuggerAttached(tabId) { this._attachedDebuggerTabs.add(tabId); this.persist(); }
    markDebuggerDetached(tabId) { this._attachedDebuggerTabs.delete(tabId); this.persist(); }
    /** Every tab currently attached — for the CDP event filter. */
    attachedDebuggerTabs() { return [...this._attachedDebuggerTabs]; }
    /**
     * Get or lazily create the session state for a given session ID.
     * @param sessionId - Session identifier, or null/undefined for single-client mode
     * @returns The session's isolated state object
     */
    getSession(sessionId) {
        const key = sessionId ?? null;
        let session = this.sessions.get(key);
        if (!session) {
            session = createSessionState();
            this.sessions.set(key, session);
        }
        return session;
    }
    /** Remove a session's state entirely (called when a multiplexer session disconnects). */
    deleteSession(sessionId) {
        this.sessions.delete(sessionId);
        this.persist();
    }
    /** Persist session state after a mutation on the session's Maps or fields. */
    persistSession() {
        this.persist();
    }
    /**
     * Every live session's state, for operations that are not attributable to a
     * caller — a tab-close event names a tab, not a session, so cleanup has to
     * sweep all of them.
     */
    sessionEntries() {
        return [...this.sessions.entries()];
    }
    // No no-arg accessors. A no-arg read resolved the `null` map key, so every
    // caller that omitted the session id shared one global tab pointer across
    // concurrent agents (D1). Callers use `getSession(sessionId)` and the
    // compiler now names anyone who forgets. Do not add them back.
    /**
     * Clear all persisted session state from chrome.storage.session.
     * Called on disable/disconnect to prevent unbounded growth across
     * multiple enable/disable cycles within a long-lived browser session.
     */
    async clearStorage() {
        if (!this.storage)
            return;
        try {
            await this.storage.remove(STORAGE_KEY);
        }
        catch { /* ignore — storage may be unavailable */ }
    }
    /** Write-through: serialize and persist current state to chrome.storage.session. */
    persist() {
        if (!this.storage)
            return;
        const serialized = {
            connected: this._connected,
            attachedDebuggerTabs: [...this._attachedDebuggerTabs],
            sessions: {},
        };
        for (const [key, session] of this.sessions) {
            const storageKey = key === null ? '__null__' : key;
            serialized.sessions[storageKey] = serializeSession(session);
        }
        // Fire and forget — don't block the caller
        this.storage.set({ [STORAGE_KEY]: serialized }).catch(() => { });
    }
    /** Rehydrate state from chrome.storage.session after service worker wake. */
    async rehydrate() {
        if (!this.storage)
            return;
        try {
            const result = await this.storage.get(STORAGE_KEY);
            const data = result?.[STORAGE_KEY];
            if (!data)
                return;
            this._connected = data.connected ?? false;
            // Deliberately not rehydrated: the service worker restarting tears down
            // every real CDP attachment, so a restored set would claim attachments
            // that no longer exist. ensureDebugger re-attaches on first use.
            this._attachedDebuggerTabs = new Set();
            if (data.sessions) {
                this.sessions.clear();
                for (const [key, serialized] of Object.entries(data.sessions)) {
                    const sessionKey = key === '__null__' ? null : key;
                    this.sessions.set(sessionKey, deserializeSession(serialized));
                }
            }
        }
        catch { /* ignore — start fresh if storage read fails */ }
    }
}
