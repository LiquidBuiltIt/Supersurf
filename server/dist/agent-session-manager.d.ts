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
import { AgentSession } from './backend';
import type { BackendConfig, ToolSchema } from './backend/types';
export declare class AgentSessionManager {
    private _config;
    private _sessions;
    private _connecting;
    private _timers;
    private _busy;
    private _lobby;
    private _multi;
    private _server;
    private _clientInfo;
    constructor(_config: BackendConfig);
    initialize(server: any, clientInfo: Record<string, unknown>): Promise<void>;
    get(username: string): AgentSession | undefined;
    private get _idleMin();
    listTools(): Promise<ToolSchema[]>;
    callTool(name: string, args?: Record<string, unknown>, options?: {
        rawResult?: boolean;
    }): Promise<any>;
    private _connect;
    private _touch;
    private _expire;
    /** Health only. Names and counts of other agents stay hidden until BACKLOG #69. */
    private _status;
    /** Prepend the caller's header to the first text block unless it already names them. */
    private _decorate;
    serverClosed(): Promise<void>;
}
//# sourceMappingURL=agent-session-manager.d.ts.map