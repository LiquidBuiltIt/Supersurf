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
 * The convenience accessors (attachedTabId, stealthMode, etc.) delegate to
 * the null-key session for backwards compatibility with single-client usage.
 */
export class SessionContext {
    /** Whether the WebSocket connection to the MCP server is active. */
    _connected = false;
    /** Whether the CDP debugger is currently attached to any tab. */
    _debuggerAttached = false;
    /** The tab ID the CDP debugger is attached to, if any. */
    _currentDebuggerTabId = null;
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
    get debuggerAttached() { return this._debuggerAttached; }
    set debuggerAttached(value) {
        this._debuggerAttached = value;
        this.persist();
    }
    get currentDebuggerTabId() { return this._currentDebuggerTabId; }
    set currentDebuggerTabId(value) {
        this._currentDebuggerTabId = value;
        this.persist();
    }
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
    // Convenience accessors for single-client backwards compat
    // These delegate to the null-key session.
    get attachedTabId() {
        return this.getSession().attachedTabId;
    }
    set attachedTabId(value) {
        this.getSession().attachedTabId = value;
        this.persist();
    }
    get stealthMode() {
        return this.getSession().stealthMode;
    }
    set stealthMode(value) {
        this.getSession().stealthMode = value;
        this.persist();
    }
    get stealthTabs() {
        return this.getSession().stealthTabs;
    }
    get cursorPositions() {
        return this.getSession().cursorPositions;
    }
    get humanizationConfig() {
        return this.getSession().humanizationConfig;
    }
    set humanizationConfig(value) {
        this.getSession().humanizationConfig = value;
        this.persist();
    }
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
            debuggerAttached: this._debuggerAttached,
            currentDebuggerTabId: this._currentDebuggerTabId,
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
            this._debuggerAttached = data.debuggerAttached ?? false;
            this._currentDebuggerTabId = data.currentDebuggerTabId ?? null;
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
