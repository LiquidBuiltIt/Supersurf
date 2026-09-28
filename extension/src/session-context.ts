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

/** Configuration for mouse humanization experiment (Bezier trajectories, idle drift). */
export interface HumanizationConfig {
  enabled: boolean;
}

/**
 * Per-session state isolated for multiplexer support.
 * Each MCP client session gets its own attached tab, stealth settings, and cursor positions.
 */
export interface SessionState {
  /** The Chrome tab ID this session is controlling, or null if not attached. */
  attachedTabId: number | null;
  /** Whether stealth mode is active (avoids detectable automation signals). */
  stealthMode: boolean;
  /** Per-tab stealth mode overrides (tab ID -> enabled). */
  stealthTabs: Map<number, boolean>;
  /** Last known cursor position per tab, used by mouse humanization for path continuity. */
  cursorPositions: Map<number, { x: number; y: number }>;
  humanizationConfig: HumanizationConfig;
}

/** JSON-serializable shape for a SessionState (Maps become entry arrays). */
interface SerializedSessionState {
  attachedTabId: number | null;
  stealthMode: boolean;
  stealthTabs: [number, boolean][];
  cursorPositions: [number, { x: number; y: number }][];
  humanizationConfig: HumanizationConfig;
}

/** JSON-serializable shape for the full persisted state. */
interface SerializedState {
  connected: boolean;
  debuggerAttached: boolean;
  currentDebuggerTabId: number | null;
  sessions: Record<string, SerializedSessionState>;
}

/** Factory for a fresh session state with safe defaults. */
function createSessionState(): SessionState {
  return {
    attachedTabId: null,
    stealthMode: false,
    stealthTabs: new Map(),
    cursorPositions: new Map(),
    humanizationConfig: { enabled: false },
  };
}

function serializeSession(s: SessionState): SerializedSessionState {
  return {
    attachedTabId: s.attachedTabId,
    stealthMode: s.stealthMode,
    stealthTabs: Array.from(s.stealthTabs.entries()),
    cursorPositions: Array.from(s.cursorPositions.entries()),
    humanizationConfig: { ...s.humanizationConfig },
  };
}

function deserializeSession(s: SerializedSessionState): SessionState {
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
 * There are no no-arg convenience accessors — callers must go through
 * `getSession(sessionId)` so the compiler names anyone who forgets which
 * session they're acting for.
 */
export class SessionContext {
  /** Whether the WebSocket connection to the MCP server is active. */
  private _connected: boolean = false;
  /** Whether the CDP debugger is currently attached to any tab. */
  private _debuggerAttached: boolean = false;
  /** The tab ID the CDP debugger is attached to, if any. */
  private _currentDebuggerTabId: number | null = null;
  /** True while a native dialog is held open and blocking the renderer.
   *  In-memory only — deliberately NOT persisted so a service-worker restart
   *  clears it (a stale-true flag would wedge the session). */
  private _dialogPending: boolean = false;

  // Per-session state. null key = single-client mode (backwards compat).
  private sessions: Map<string | null, SessionState> = new Map();

  /** Reference to chrome.storage.session for persistence. */
  private storage: typeof chrome.storage.session | null = null;

  /**
   * Initialize persistence layer. Must be called before use in background.ts.
   * Safe to skip in tests or environments without chrome.storage.session.
   */
  async init(chromeRef?: typeof chrome): Promise<void> {
    const storageSession = chromeRef?.storage?.session;
    if (!storageSession) return;
    this.storage = storageSession;
    await this.rehydrate();
  }

  // ── Persisted top-level properties with write-through ──

  get connected(): boolean { return this._connected; }
  set connected(value: boolean) {
    this._connected = value;
    this.persist();
  }

  get debuggerAttached(): boolean { return this._debuggerAttached; }
  set debuggerAttached(value: boolean) {
    this._debuggerAttached = value;
    this.persist();
  }

  get currentDebuggerTabId(): number | null { return this._currentDebuggerTabId; }
  set currentDebuggerTabId(value: number | null) {
    this._currentDebuggerTabId = value;
    this.persist();
  }

  get dialogPending(): boolean { return this._dialogPending; }
  set dialogPending(value: boolean) { this._dialogPending = value; }

  /**
   * Get or lazily create the session state for a given session ID.
   * @param sessionId - Session identifier, or null/undefined for single-client mode
   * @returns The session's isolated state object
   */
  getSession(sessionId?: string | null): SessionState {
    const key = sessionId ?? null;
    let session = this.sessions.get(key);
    if (!session) {
      session = createSessionState();
      this.sessions.set(key, session);
    }
    return session;
  }

  /** Remove a session's state entirely (called when a multiplexer session disconnects). */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.persist();
  }

  /** Persist session state after a mutation on the session's Maps or fields. */
  persistSession(): void {
    this.persist();
  }

  /**
   * Every live session's state, for operations that are not attributable to a
   * caller — a tab-close event names a tab, not a session, so cleanup has to
   * sweep all of them.
   */
  sessionEntries(): [string | null, SessionState][] {
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
  async clearStorage(): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.remove(STORAGE_KEY);
    } catch { /* ignore — storage may be unavailable */ }
  }

  /** Write-through: serialize and persist current state to chrome.storage.session. */
  private persist(): void {
    if (!this.storage) return;

    const serialized: SerializedState = {
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
    this.storage.set({ [STORAGE_KEY]: serialized }).catch(() => {});
  }

  /** Rehydrate state from chrome.storage.session after service worker wake. */
  private async rehydrate(): Promise<void> {
    if (!this.storage) return;
    try {
      const result = await this.storage.get(STORAGE_KEY);
      const data = result?.[STORAGE_KEY] as SerializedState | undefined;
      if (!data) return;

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
    } catch { /* ignore — start fresh if storage read fails */ }
  }
}
