"use strict";
/**
 * WebSocket bridge to Chrome extension(s).
 *
 * Runs an HTTP + WebSocket server on localhost (default port 5555).
 * Communication uses JSON-RPC 2.0 with correlation IDs for request/response matching.
 *
 * When profiles are enabled, supports multiple concurrent extension connections via
 * the Matchmaker connection pool. When profiles are disabled, operates in single-
 * connection mode (rejects additional connections, same as v1).
 *
 * @module extension-bridge
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtensionBridge = void 0;
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const matchmaker_1 = require("./profiles/matchmaker");
const debugLog = (...args) => {
    const logger = global.DAEMON_LOGGER;
    if (logger)
        logger.log('[WS]', ...args);
    else if (global.DAEMON_DEBUG)
        console.error('[WS]', ...args);
};
/** Registration HTML template served at /register/:name. */
function registrationHtml(profileName) {
    return `<html>
<head><title>Registering Profile...</title></head>
<body>
<p>Registering profile "${profileName}"... This tab will close automatically.</p>
<script>
  window.postMessage({ __supersurf: true, action: 'register-profile', profile: '${profileName}' }, '*');
</script>
</body>
</html>`;
}
/**
 * WebSocket server that bridges the daemon to Chrome extension(s).
 * Supports both single-connection (v1) and pooled connection (profiles) modes.
 */
class ExtensionBridge {
    port;
    host;
    httpServer = null;
    wss = null;
    profilesEnabled;
    /** Connection pool and profile-based routing. */
    matchmaker;
    onReconnect = null;
    onTabInfoUpdate = null;
    constructor(port = 5555, host = '127.0.0.1', profilesEnabled = false) {
        this.port = port;
        this.host = host;
        this.profilesEnabled = profilesEnabled;
        this.matchmaker = new matchmaker_1.Matchmaker();
    }
    /** Browser name from the first available connection (backwards compat). */
    get browser() {
        for (const conn of this.matchmaker['pool'].values()) {
            if (conn.ws.readyState === ws_1.WebSocket.OPEN)
                return conn.browser;
        }
        return 'chrome';
    }
    /** Build timestamp from the first available connection (backwards compat). */
    get buildTime() {
        for (const conn of this.matchmaker['pool'].values()) {
            if (conn.ws.readyState === ws_1.WebSocket.OPEN)
                return conn.buildTimestamp;
        }
        return null;
    }
    /** True if at least one extension is connected. */
    get connected() {
        return this.matchmaker.hasConnections;
    }
    /** Spin up the HTTP + WebSocket server and begin accepting connections. */
    async start() {
        return new Promise((resolve, reject) => {
            this.httpServer = http_1.default.createServer((req, res) => {
                // Profile registration endpoint
                if (this.profilesEnabled && req.url) {
                    const match = req.url.match(/^\/register\/([a-z0-9][a-z0-9-]*)$/);
                    if (match) {
                        const profileName = match[1];
                        debugLog(`Serving registration page for profile: ${profileName}`);
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(registrationHtml(profileName));
                        return;
                    }
                }
                res.writeHead(200);
                res.end('SuperSurf Daemon');
            });
            this.wss = new ws_1.WebSocketServer({ server: this.httpServer });
            this.wss.on('error', (error) => {
                debugLog('WebSocketServer error:', error);
                reject(error);
            });
            this.wss.on('connection', (ws) => {
                debugLog('Extension connection attempt');
                if (!this.profilesEnabled) {
                    // Single-connection mode: reject if already connected
                    if (this.matchmaker.hasConnections) {
                        debugLog('Rejecting new connection — browser already connected (profiles disabled)');
                        const errorMsg = {
                            jsonrpc: '2.0',
                            error: {
                                code: -32001,
                                message: 'Another browser is already connected. Only one browser at a time.',
                            },
                        };
                        ws.send(JSON.stringify(errorMsg));
                        setTimeout(() => ws.close(1008, 'Already connected'), 100);
                        return;
                    }
                }
                // Create pooled connection entry
                const conn = {
                    ws,
                    profile: null,
                    browser: 'chrome',
                    buildTimestamp: null,
                    pingInterval: null,
                    inflight: new Map(),
                };
                // Keep-alive ping every 10s
                conn.pingInterval = setInterval(() => {
                    if (ws.readyState === ws_1.WebSocket.OPEN) {
                        ws.ping();
                    }
                }, 10000);
                // Add to pool
                this.matchmaker.addConnection(ws, conn);
                debugLog('Extension connected');
                ws.on('message', (data) => this.handleMessage(ws, conn, data));
                ws.on('pong', () => debugLog('Pong received'));
                ws.on('close', () => {
                    debugLog('Extension disconnected');
                    this.matchmaker.removeConnection(ws);
                });
                ws.on('error', (error) => debugLog('WebSocket error:', error));
            });
            this.httpServer.on('error', (error) => {
                debugLog('HTTP Server error:', error);
                reject(error);
            });
            this.httpServer.listen(this.port, this.host, () => {
                debugLog(`Server listening on ${this.host}:${this.port}`);
                resolve();
            });
        });
    }
    /** Route incoming WebSocket messages for a specific connection. */
    handleMessage(ws, conn, data) {
        try {
            const message = JSON.parse(data.toString());
            // JSON-RPC response — correlate with connection's inflight map
            if (message.id !== undefined && !message.method) {
                const pending = conn.inflight.get(message.id);
                if (pending) {
                    conn.inflight.delete(message.id);
                    // Piggyback: extract tab info from response if present
                    const result = message.result;
                    if (result && typeof result === 'object' && 'currentTab' in result && this.onTabInfoUpdate) {
                        this.onTabInfoUpdate(result.currentTab);
                    }
                    if (message.error) {
                        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
                    }
                    else {
                        pending.resolve(message.result);
                    }
                }
                return;
            }
            // Handshake
            if (message.type === 'handshake') {
                debugLog('Handshake received:', message);
                conn.browser = message.browser || 'chrome';
                conn.buildTimestamp = message.buildTimestamp || null;
                // Profile field in handshake (subsequent launches)
                if (message.profile) {
                    this.matchmaker.updateProfile(ws, message.profile);
                }
                // Notify about reconnection (backwards compat for unmanaged)
                if (!this.profilesEnabled && this.onReconnect) {
                    this.onReconnect();
                }
                return;
            }
            // Profile announcement notification (first launch, after registration)
            if (message.method === 'profile_announce' && message.params?.profile) {
                debugLog('Profile announcement:', message.params.profile);
                this.matchmaker.updateProfile(ws, message.params.profile);
                return;
            }
            // Tab info notification
            if (message.method && message.id === undefined) {
                debugLog('Notification:', message.method);
                if (message.method === 'notifications/tab_info_update' &&
                    message.params?.currentTab &&
                    this.onTabInfoUpdate) {
                    this.onTabInfoUpdate(message.params.currentTab);
                }
                return;
            }
        }
        catch (error) {
            debugLog('Error handling message:', error);
        }
    }
    /**
     * Send a JSON-RPC 2.0 request to the unmanaged extension connection.
     * Backwards-compatible with v1 — delegates to matchmaker for the unmanaged connection.
     */
    async sendCmd(method, params = {}, timeout = 30000) {
        const conn = this.matchmaker.getConnectionForProfile(null);
        if (!conn) {
            throw new Error('Extension not connected');
        }
        return this.matchmaker.sendCmd(conn, method, params, timeout);
    }
    /**
     * Send a JSON-RPC 2.0 request to a specific profile's extension connection.
     */
    async sendCmdToProfile(profile, method, params = {}, timeout = 30000) {
        const conn = this.matchmaker.getConnectionForProfile(profile);
        if (!conn) {
            throw new Error(`No extension connected for profile "${profile}"`);
        }
        return this.matchmaker.sendCmd(conn, method, params, timeout);
    }
    /** Send an `authenticated` notification to the extension with a session's client ID. */
    notifyClientId(clientId) {
        debugLog('Client ID set to:', clientId);
        // Send to unmanaged connection (backwards compat)
        const conn = this.matchmaker.getConnectionForProfile(null);
        if (conn && conn.ws.readyState === ws_1.WebSocket.OPEN) {
            const notification = {
                jsonrpc: '2.0',
                method: 'authenticated',
                params: { client_id: clientId },
            };
            conn.ws.send(JSON.stringify(notification));
        }
    }
    /** Gracefully shut down: close all connections, close servers. */
    async stop() {
        debugLog('Stopping server');
        this.matchmaker.shutdown();
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        if (this.httpServer) {
            return new Promise((resolve) => {
                this.httpServer.close(() => {
                    debugLog('Server stopped');
                    resolve();
                });
            });
        }
    }
}
exports.ExtensionBridge = ExtensionBridge;
//# sourceMappingURL=extension-bridge.js.map