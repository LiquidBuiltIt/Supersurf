"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentSessionManager = void 0;
/**
 * AgentSessionManager — one MCP server process, many agents.
 *
 * Every non-exempt tool call carries `username`; the manager routes it to that
 * agent's AgentSession (whose clientId IS the daemon session id). Exempt tools
 * run on a lobby session that never connects. Every MCP result leaves here
 * carrying the caller's status header, errors included, so an agent can always
 * read its own name back.
 *
 * With `agents.multi_agent` off (the default) none of that applies: the lobby IS the
 * one session, named by `client_id`, and every call passes straight through (4.0.0 semantics).
 *
 * @module agent-session-manager
 */
const backend_1 = require("./backend");
const handlers_1 = require("./backend/handlers");
const types_1 = require("./backend/types");
const daemon_spawn_1 = require("./daemon-spawn");
const EXEMPT = new Set(['status', 'profile_create', 'profile_list', 'profile_delete', 'reload_mcp', 'experimental_features']);
const MARKER = '👤 you are ';
const MISSING = 'username required — your username is in the status line of your earlier SuperSurf results.';
const MISSING_NONE = ' No agent is connected yet — call `connect` with your own username first.';
function unknownText(username, idleMin) {
    return `No live session for username "${username}". Check the status line of your earlier SuperSurf results for your exact username. ` +
        `If it expired after ${idleMin} min idle, its tabs are closed — call \`connect\` to start again.`;
}
function errorResult(text, raw, code) {
    return raw ? { success: false, error: code, message: text } : { content: [{ type: 'text', text }], isError: true };
}
class AgentSessionManager {
    _config;
    _sessions = new Map();
    _connecting = new Set();
    _timers = new Map();
    _busy = new Map();
    _lobby;
    _multi;
    _server = null;
    _clientInfo = {};
    constructor(_config) {
        this._config = _config;
        this._lobby = new backend_1.AgentSession(_config);
        this._multi = (0, types_1.isMultiAgent)(_config);
    }
    async initialize(server, clientInfo) {
        this._server = server;
        this._clientInfo = clientInfo;
        await this._lobby.initialize(server, clientInfo);
    }
    get(username) {
        return this._sessions.get(username);
    }
    get _idleMin() {
        return Math.round((this._config.configService?.get().agents.idle_timeout_ms ?? 600_000) / 60_000);
    }
    async listTools() {
        const tools = await this._lobby.listTools();
        if (!this._multi)
            return tools;
        return tools.map(t => {
            if (EXEMPT.has(t.name) || t.name === 'connect')
                return t;
            const schema = t.inputSchema ?? { type: 'object', properties: {} };
            return {
                ...t,
                inputSchema: {
                    ...schema,
                    properties: {
                        username: { type: 'string', description: 'Your username from `connect` (shown in every status line).' },
                        ...(schema.properties ?? {}),
                    },
                    required: [...new Set(['username', ...(schema.required ?? [])])],
                },
            };
        });
    }
    async callTool(name, args = {}, options = {}) {
        if (!this._multi) {
            if (name !== 'connect')
                return this._lobby.callTool(name, args, options);
            const { client_id, username: _ignored, ...rest } = args;
            return this._lobby.callTool(name, { ...rest, username: client_id }, options);
        }
        const raw = !!options.rawResult;
        const { username: rawName, ...rest } = args;
        const username = typeof rawName === 'string' ? rawName.trim() : '';
        if (name === 'status') {
            const s = username ? this._sessions.get(username) : undefined;
            if (s) {
                this._touch(username);
                return raw ? s.callTool('status', rest, options) : this._decorate(s, await s.callTool('status', rest, options));
            }
            return this._status(raw, username ? unknownText(username, this._idleMin) : undefined);
        }
        if (EXEMPT.has(name))
            return this._lobby.callTool(name, rest, options);
        if (name === 'connect')
            return this._connect(username, rest, options);
        if (!username) {
            return errorResult(MISSING + (this._sessions.size === 0 ? MISSING_NONE : ''), raw, 'missing_username');
        }
        const session = this._sessions.get(username);
        if (!session) {
            return errorResult(unknownText(username, this._idleMin), raw, 'unknown_username');
        }
        let result;
        this._busy.set(session, (this._busy.get(session) ?? 0) + 1);
        this._touch(username);
        try {
            result = await session.callTool(name, rest, options);
        }
        catch (err) {
            if (raw)
                throw err;
            result = { content: [{ type: 'text', text: `### Error\n\n${err?.message ?? String(err)}` }], isError: true };
        }
        finally {
            if (name === 'disconnect' && session.state === 'passive') {
                this._sessions.delete(username);
                clearTimeout(this._timers.get(username));
                this._timers.delete(username);
                this._busy.delete(session);
            }
            else {
                const n = (this._busy.get(session) ?? 1) - 1;
                if (n > 0)
                    this._busy.set(session, n);
                else
                    this._busy.delete(session);
                if (this._sessions.get(username) === session)
                    this._touch(username);
            }
        }
        return raw ? result : this._decorate(session, result);
    }
    async _connect(username, rest, options) {
        if (username && handlers_1.USERNAME_RE.test(username) && (this._sessions.has(username) || this._connecting.has(username))) {
            return errorResult(`Username "${username}" is already in use by a live agent. Pick another username and call \`connect\` again.`, !!options.rawResult, 'username_in_use');
        }
        // Validation of empty / malformed names stays in onConnect (Task 4) — one copy of those texts.
        this._connecting.add(username);
        try {
            const session = new backend_1.AgentSession(this._config);
            await session.initialize(this._server, this._clientInfo);
            const result = await session.callTool('connect', { ...rest, username }, options);
            if (session.state !== 'passive') {
                this._sessions.set(username, session);
                this._touch(username);
            }
            return result;
        }
        finally {
            this._connecting.delete(username);
        }
    }
    _touch(username) {
        clearTimeout(this._timers.get(username));
        // Node clamps setTimeout delays above 2^31-1 ms to 1 ms.
        const ms = Math.min(this._config.configService?.get().agents.idle_timeout_ms ?? 600_000, 2 ** 31 - 1);
        const t = setTimeout(() => { void this._expire(username); }, ms);
        t.unref?.();
        this._timers.set(username, t);
    }
    async _expire(username) {
        const s = this._sessions.get(username);
        if (s && (this._busy.get(s) ?? 0) > 0)
            return this._touch(username);
        this._sessions.delete(username);
        this._timers.delete(username);
        await s?.callTool('disconnect', {}, { rawResult: true }).catch(() => { });
    }
    /** Health only. Names and counts of other agents stay hidden until BACKLOG #69. */
    async _status(raw, warning) {
        const d = await (0, daemon_spawn_1.queryDaemonStatus)();
        const version = this._config.server.version;
        const daemon = d
            ? { running: true, version: d.version, uptime_seconds: Math.round(d.uptimeSeconds), extension_connected: !!d.extensionConnected, browser: d.extensionBrowser ?? null }
            : { running: false };
        if (raw)
            return warning ? { server_version: version, daemon, warning } : { server_version: version, daemon };
        const lines = [`SuperSurf v${version}`];
        if (!d)
            lines.push('Daemon: not running — `connect` starts it.');
        else
            lines.push(`Daemon: v${daemon.version}, up ${daemon.uptime_seconds}s`, `Extension: ${daemon.extension_connected ? `connected (${daemon.browser ?? 'unknown browser'})` : 'not connected'}`);
        lines.push('', 'Pass your `username` to `status` to see your own session.');
        if (warning)
            lines.push(warning);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    /** Prepend the caller's header to the first text block unless it already names them. */
    _decorate(session, result) {
        const first = result?.content?.find?.((b) => b?.type === 'text');
        if (!first)
            return result;
        if (!first.text.includes(MARKER))
            first.text = session.statusHeader() + first.text;
        return result;
    }
    async serverClosed() {
        for (const t of this._timers.values())
            clearTimeout(t);
        this._timers.clear();
        this._busy.clear();
        for (const s of this._sessions.values())
            await s.serverClosed().catch(() => { });
        this._sessions.clear();
        await this._lobby.serverClosed();
    }
}
exports.AgentSessionManager = AgentSessionManager;
//# sourceMappingURL=agent-session-manager.js.map