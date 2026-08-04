/**
 * WebSocket connection manager -- connects to the local MCP server.
 *
 * Implements JSON-RPC 2.0 over WebSocket for bidirectional communication between
 * the Chrome extension and the Node.js MCP server running on localhost.
 *
 * Key design decisions:
 * - Uses chrome.alarms for reconnection instead of setTimeout, because MV3 service
 *   workers can be suspended at any time, killing pending timers. Alarms survive suspension.
 * - 5-second reconnect backoff with deduplication (reconnectTimeout flag prevents stacking).
 * - 30-second keepalive alarm (registered in background.ts) ensures connection health.
 * - Handshake on connect sends browser name, extension version, and build timestamp
 *   so the server can validate compatibility.
 * - Command/notification handler maps allow background.ts to register handlers declaratively.
 *
 * Stripped of PRO/relay/OAuth logic (direct localhost mode only).
 * Adapted from Blueprint MCP (Apache 2.0).
 */
/** Unique marker returned by the in-flight race when a dialog interrupts a command. */
const DIALOG_INTERRUPT = Symbol('dialog-interrupt');
/** Methods allowed to run while a native dialog is held open. */
const DIALOG_SAFE_METHODS = new Set(['dialog', 'getTabs']);
/**
 * Manages the WebSocket lifecycle and JSON-RPC message routing between the
 * extension and the local MCP server.
 */
export class WebSocketConnection {
    browser;
    logger;
    iconManager;
    buildTimestamp;
    socket = null;
    isConnected = false;
    /** Client ID / project name received from the server's `authenticated` notification. */
    projectName = null;
    connectionUrl = null;
    /** Reconnect guard -- set to a truthy value while a reconnect alarm is pending. */
    reconnectTimeout = null;
    reconnectDelay = 5000;
    /** Registered handlers for JSON-RPC commands (requests with an `id`). */
    commandHandlers = new Map();
    /** Registered handlers for JSON-RPC notifications (no `id`, fire-and-forget). */
    notificationHandlers = new Map();
    /**
     * Optional hook consulted after each command handler returns. Used by
     * the tab recovery system to attach a `_recovery` note to the response
     * envelope whenever the extension auto-reattached to a different tab
     * mid-call. Returns a recovery object, or null if none happened.
     */
    recoveryNoteProvider = null;
    /**
     * Optional reset hook, fired right before each command runs so the
     * tab handler can drop any stale recovery-note buffer from a prior call.
     */
    recoveryNoteReset = null;
    /** Register the recovery note provider (see `recoveryNoteProvider`). */
    setRecoveryNoteProvider(provider, reset) {
        this.recoveryNoteProvider = provider;
        this.recoveryNoteReset = reset ?? null;
    }
    /**
     * Optional hook consulted after each command handler returns. Used by
     * the dialog handler to attach a `_dialogs` array to the response
     * envelope listing any native/overridden dialogs that fired during the
     * call (or since the previous call). Returns an array of events, or
     * empty if none.
     */
    dialogEventProvider = null;
    /** Returns true while a native dialog is held open (renderer frozen). */
    dialogPendingChecker = null;
    /**
     * Single-slot resolver for the current in-flight command's dialog race.
     *
     * ASSUMPTION: per-tab serialized dispatch. The daemon scheduler routes
     * commands to the extension one at a time per tab, so only one command
     * can be in-flight here at any moment. If two commands were dispatched
     * concurrently before the first awaits, the second assignment would
     * overwrite the first resolver and the first's interrupt promise would
     * hang until timeout. The serialization guarantee from the scheduler
     * makes this safe — do NOT add locking or a queue unless that guarantee
     * is removed.
     */
    _dialogRaceResolve = null;
    /** Register the dialog event provider (see `dialogEventProvider`). */
    setDialogEventProvider(provider) {
        this.dialogEventProvider = provider;
    }
    /** Register the predicate used to short-circuit page commands while a dialog is held. */
    setDialogPendingChecker(fn) {
        this.dialogPendingChecker = fn;
    }
    /** Called by the background dialog listener the instant CDP holds a dialog open.
     *  Resolves the in-flight command's race so it returns immediately. */
    notifyDialogOpened() {
        if (this._dialogRaceResolve)
            this._dialogRaceResolve();
    }
    constructor(browserAPI, logger, iconManager, buildTimestamp = null) {
        this.browser = browserAPI;
        this.logger = logger;
        this.iconManager = iconManager;
        this.buildTimestamp = buildTimestamp;
    }
    /**
     * Register a handler for a JSON-RPC command method.
     * @param method - The RPC method name (e.g., 'navigate', 'screenshot', 'evaluate')
     * @param handler - Async function that receives params and returns the result
     */
    registerCommandHandler(method, handler) {
        this.commandHandlers.set(method, handler);
    }
    /**
     * Register a handler for a JSON-RPC notification (no response expected).
     * @param method - The notification method name
     * @param handler - Async function that processes the notification params
     */
    registerNotificationHandler(method, handler) {
        this.notificationHandlers.set(method, handler);
    }
    /** Check chrome.storage.local for the extension enabled flag (defaults to true if unset). */
    async isExtensionEnabled() {
        const result = await this.browser.storage.local.get(['extensionEnabled']);
        return result.extensionEnabled !== false;
    }
    /** Build the WebSocket URL from the configured port (default 5555). */
    async getConnectionUrl() {
        const result = await this.browser.storage.local.get(['mcpPort']);
        const port = result.mcpPort || '5555';
        const url = `ws://127.0.0.1:${port}/extension`;
        this.logger.log(`[WebSocket] Connecting to ${url}`);
        return url;
    }
    /**
     * Establish a WebSocket connection to the MCP server.
     * Guards against duplicate connections, respects the enabled flag, and
     * cleans up any lingering socket before creating a new one.
     */
    async connect() {
        try {
            // Don't create duplicate connections
            if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) {
                this.logger.log('[WebSocket] Already connected or connecting, skipping');
                return;
            }
            const isEnabled = await this.isExtensionEnabled();
            if (!isEnabled) {
                this.logger.log('[WebSocket] Extension disabled, skipping auto-connect');
                return;
            }
            if (this.iconManager) {
                await this.iconManager.updateConnectingBadge();
            }
            const url = await this.getConnectionUrl();
            this.connectionUrl = url;
            // Clean up old socket if lingering
            if (this.socket) {
                try {
                    this.socket.close();
                }
                catch { }
                this.socket = null;
            }
            this.socket = new WebSocket(url);
            this.socket.onopen = () => this._handleOpen();
            this.socket.onmessage = (event) => this._onMessage(event);
            this.socket.onerror = (error) => this._handleError(error);
            this.socket.onclose = (event) => this._handleClose(event);
        }
        catch (error) {
            this.logger.logAlways('[WebSocket] Connection error:', error);
            if (this.iconManager) {
                await this.iconManager.setGlobalIcon('normal', 'Connection failed');
            }
            this._scheduleReconnect();
        }
    }
    /** Cleanly disconnect: cancel reconnect alarms, close socket, update UI. */
    disconnect() {
        // Cancel any pending reconnect alarm
        try {
            this.browser.alarms.clear('ws-reconnect');
        }
        catch { }
        this.reconnectTimeout = null;
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.isConnected = false;
        if (this.iconManager) {
            this.iconManager.setConnected(false);
            this.iconManager.setGlobalIcon('normal', 'Disconnected');
        }
        try {
            this.browser.runtime.sendMessage({ type: 'statusChanged' });
        }
        catch { }
    }
    /** Send a JSON-serialized message over the WebSocket. Logs error if not connected. */
    send(message) {
        if (this.socket && this.isConnected) {
            this.socket.send(JSON.stringify(message));
        }
        else {
            this.logger.error('[WebSocket] Cannot send: not connected');
        }
    }
    /** Send a JSON-RPC 2.0 notification (no `id`, no response expected). */
    sendNotification(method, params) {
        if (!this.socket || !this.isConnected)
            return;
        this.send({ jsonrpc: '2.0', method, params });
    }
    notifyKeepBrowserOnSessionEnd(keepBrowserOnSessionEnd) {
        if (!this.isConnected)
            return;
        this.sendNotification('session/keep_browser', { keepBrowserOnSessionEnd });
    }
    // ── Internal handlers ──
    /** On successful connection: update state, send handshake with browser metadata. */
    _handleOpen() {
        this.logger.logAlways(`Connected to ${this.connectionUrl}`);
        this.isConnected = true;
        if (this.iconManager) {
            this.iconManager.setConnected(true);
            this.iconManager.setGlobalIcon('connected', 'Connected to MCP server');
        }
        try {
            this.browser.runtime.sendMessage({ type: 'statusChanged' });
        }
        catch { }
        // Resolve profile name: chrome.storage.local first, then cookie fallback
        this._resolveProfile().then(async (profile) => {
            let keepBrowserOnSessionEnd = false;
            try {
                const stored = await this.browser.storage.local.get(['keepBrowserOnSessionEnd']);
                keepBrowserOnSessionEnd = stored?.keepBrowserOnSessionEnd === true;
            }
            catch { }
            this.send({
                type: 'handshake',
                browser: this._getBrowserName(),
                version: this.browser.runtime.getManifest().version,
                buildTimestamp: this.buildTimestamp,
                keepBrowserOnSessionEnd,
                ...(profile ? { profile } : {}),
            });
        });
    }
    /**
     * Resolve the profile name from available sources.
     * Priority: chrome.storage.local > cookie on daemon origin.
     * If found via cookie but missing from storage, backfill storage for next time.
     */
    async _resolveProfile() {
        // Primary: chrome.storage.local
        try {
            const result = await this.browser.storage.local.get(['supersurf_profile']);
            if (result?.supersurf_profile) {
                return result.supersurf_profile;
            }
        }
        catch { }
        // Fallback: read cookie from daemon origin
        try {
            const port = (await this.browser.storage.local.get(['mcpPort'])).mcpPort || '5555';
            const cookie = await this.browser.cookies.get({
                url: `http://127.0.0.1:${port}`,
                name: 'supersurf_profile',
            });
            if (cookie?.value) {
                this.logger.log(`[WebSocket] Profile resolved from cookie: ${cookie.value}`);
                // Backfill storage so the primary path works next time
                await this.browser.storage.local.set({ supersurf_profile: cookie.value });
                return cookie.value;
            }
        }
        catch { }
        return null;
    }
    /**
     * Thin wrapper wired to `socket.onmessage`. JSON-parses the raw frame
     * string from `event.data`, then delegates to `_handleMessage` with the
     * parsed object. Logs and returns on parse failure so a malformed or
     * binary frame never reaches the routing logic.
     */
    async _onMessage(event) {
        let message;
        try {
            message = JSON.parse(event.data);
        }
        catch (err) {
            this.logger.error('[WebSocket] Failed to parse incoming message:', err);
            return;
        }
        await this._handleMessage(message);
    }
    /**
     * Route an already-parsed JSON-RPC message to the appropriate handler.
     * Distinguishes between notifications (no id) and commands (has id + method).
     * Commands get a JSON-RPC response sent back; errors include stack traces for debugging.
     */
    async _handleMessage(message) {
        try {
            this.logger.log('[WebSocket] Received:', message);
            if (message.error) {
                this.logger.logAlways('[WebSocket] Server error:', message.error);
                return;
            }
            // Notification (method, no id)
            if (!message.id && message.method) {
                await this._handleNotification(message);
                return;
            }
            // Command (has id and method)
            if (this.recoveryNoteReset) {
                try {
                    this.recoveryNoteReset();
                }
                catch { /* never break a command */ }
            }
            // Race the handler against a dialog-interrupt signal. If a native dialog
            // is held open mid-command, the renderer freezes and the handler hangs;
            // notifyDialogOpened() (fired from the SW-thread CDP listener) resolves
            // the race so we can return the held dialog in the _dialogs envelope
            // instead of waiting for the handler's timeout.
            const interrupt = new Promise((resolve) => {
                this._dialogRaceResolve = () => resolve(DIALOG_INTERRUPT);
            });
            let routed;
            try {
                routed = await Promise.race([this._routeCommand(message), interrupt]);
            }
            finally {
                this._dialogRaceResolve = null;
            }
            const response = routed === DIALOG_INTERRUPT
                ? { interrupted: 'dialog' }
                : routed;
            // Attach a tab-recovery note to the response if ensureAttachedTab()
            // fired this call. Stored as `_recovery` on the result so the server
            // and ultimately the agent can see the attached tab changed.
            let finalResponse = response;
            if (this.recoveryNoteProvider) {
                try {
                    const note = this.recoveryNoteProvider();
                    if (note) {
                        if (finalResponse && typeof finalResponse === 'object') {
                            finalResponse = { ...finalResponse, _recovery: note };
                        }
                        else {
                            finalResponse = { value: finalResponse, _recovery: note };
                        }
                    }
                }
                catch { /* never let the hook break a response */ }
            }
            if (this.dialogEventProvider) {
                try {
                    const events = this.dialogEventProvider();
                    if (events && events.length > 0) {
                        if (finalResponse && typeof finalResponse === 'object') {
                            finalResponse = { ...finalResponse, _dialogs: events };
                        }
                        else {
                            finalResponse = { value: finalResponse, _dialogs: events };
                        }
                    }
                }
                catch { /* never let the hook break a response */ }
            }
            this.send({ jsonrpc: '2.0', id: message.id, result: finalResponse });
        }
        catch (error) {
            this.logger.logAlways('[WebSocket] Command error:', error);
            if (message?.id) {
                this.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { message: error.message, stack: error.stack },
                });
            }
        }
    }
    async _handleNotification(message) {
        const { method, params } = message;
        if (method === 'authenticated' && params?.client_id) {
            this.projectName = params.client_id;
            this.logger.log('[WebSocket] Project name set:', this.projectName);
        }
        const handler = this.notificationHandlers.get(method);
        if (handler)
            await handler(params);
    }
    async _routeCommand(message) {
        const { method, params } = message;
        if (this.dialogPendingChecker?.() && !DIALOG_SAFE_METHODS.has(method)) {
            throw new Error('A native dialog is blocking the page. Inspect it with ' +
                'browser_handle_dialog {action:"view"}, then resolve it with ' +
                '{action:"accept"} or {action:"dismiss"} before issuing other commands.');
        }
        const handler = this.commandHandlers.get(method);
        if (!handler)
            throw new Error(`Unknown command: ${method}`);
        return await handler(params, message);
    }
    _handleError(_error) {
        this.logger.logAlways('[WebSocket] WebSocket error');
        this.isConnected = false;
        if (this.iconManager)
            this.iconManager.setConnected(false);
    }
    _handleClose(event) {
        this.logger.logAlways(`Disconnected — Code: ${event?.code}, Reason: ${event?.reason || 'none'}`);
        this.isConnected = false;
        if (this.iconManager) {
            this.iconManager.setConnected(false);
            this.iconManager.setGlobalIcon('normal', 'Disconnected');
        }
        try {
            this.browser.runtime.sendMessage({ type: 'statusChanged' });
        }
        catch { }
        this._scheduleReconnect();
    }
    /**
     * Schedule a reconnect attempt using chrome.alarms instead of setTimeout.
     * MV3 service workers can be terminated at any time, killing setTimeout callbacks.
     * Chrome alarms persist across suspensions and will wake the service worker.
     */
    _scheduleReconnect() {
        if (this.reconnectTimeout)
            return;
        this.logger.log(`[WebSocket] Scheduling reconnect in ${this.reconnectDelay}ms...`);
        this.reconnectTimeout = -1; // flag to prevent duplicate scheduling
        // Use chrome.alarms — MV3 kills setTimeout when service worker suspends
        try {
            this.browser.alarms.clear('ws-reconnect');
        }
        catch { }
        this.browser.alarms.create('ws-reconnect', { when: Date.now() + this.reconnectDelay });
    }
    /** Called by background.ts when the 'ws-reconnect' alarm fires. */
    handleReconnectAlarm() {
        this.reconnectTimeout = null;
        if (!this.isConnected) {
            this.connect();
        }
    }
    /** Extract browser name from extension manifest for the handshake payload. */
    _getBrowserName() {
        const manifest = this.browser.runtime.getManifest();
        const name = manifest.name || '';
        const match = name.match(/SuperSurf(?:\s+for\s+)?(\w+)?/i);
        if (match?.[1])
            return match[1];
        return 'Chrome';
    }
}
