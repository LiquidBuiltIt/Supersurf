/**
 * AgentSessionManager — one MCP server process, many agents.
 *
 * Every non-exempt tool call carries `username`; the manager routes it to that
 * agent's AgentSession (whose clientId IS the daemon session id). Exempt tools
 * run on a lobby session that never connects. Every MCP result leaves here
 * carrying the caller's status header, errors included, so an agent can always
 * read its own name back.
 *
 * @module agent-session-manager
 */
import { AgentSession } from './backend';
import { USERNAME_RE } from './backend/handlers';
import type { BackendConfig, ToolSchema } from './backend/types';

const EXEMPT = new Set(['status', 'profile_create', 'profile_list', 'profile_delete', 'reload_mcp', 'experimental_features']);
const MARKER = '👤 you are ';

const MISSING = 'username required — your username is in the status line of your earlier SuperSurf results.';
const MISSING_NONE = ' No agent is connected yet — call `connect` with your own username first.';

function errorResult(text: string, raw: boolean, code: string): any {
  return raw ? { success: false, error: code, message: text } : { content: [{ type: 'text', text }], isError: true };
}

export class AgentSessionManager {
  private _sessions = new Map<string, AgentSession>();
  private _connecting = new Set<string>();
  private _lobby: AgentSession;
  private _server: any = null;
  private _clientInfo: Record<string, unknown> = {};

  constructor(private _config: BackendConfig) {
    this._lobby = new AgentSession(_config);
  }

  async initialize(server: any, clientInfo: Record<string, unknown>): Promise<void> {
    this._server = server;
    this._clientInfo = clientInfo;
    await this._lobby.initialize(server, clientInfo);
  }

  get(username: string): AgentSession | undefined {
    return this._sessions.get(username);
  }

  private get _idleMin(): number {
    return Math.round((this._config.configService?.get().agents.idle_timeout_ms ?? 600_000) / 60_000);
  }

  async listTools(): Promise<ToolSchema[]> {
    const tools = await this._lobby.listTools();
    return tools.map(t => {
      if (EXEMPT.has(t.name) || t.name === 'connect') return t;
      const schema = t.inputSchema ?? { type: 'object', properties: {} };
      return {
        ...t,
        inputSchema: {
          ...schema,
          properties: {
            username: { type: 'string', description: 'Your username from `connect` (shown in every status line).' },
            ...((schema.properties as Record<string, unknown> | undefined) ?? {}),
          },
          required: [...new Set(['username', ...((schema.required as string[] | undefined) ?? [])])],
        },
      };
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}, options: { rawResult?: boolean } = {}): Promise<any> {
    const raw = !!options.rawResult;
    const { username: rawName, ...rest } = args;
    const username = typeof rawName === 'string' ? rawName.trim() : '';

    if (EXEMPT.has(name)) return this._lobby.callTool(name, rest, options);

    if (name === 'connect') return this._connect(username, rest, options);

    if (!username) {
      return errorResult(MISSING + (this._sessions.size === 0 ? MISSING_NONE : ''), raw, 'missing_username');
    }
    const session = this._sessions.get(username);
    if (!session) {
      return errorResult(
        `No live session for username "${username}". Check the status line of your earlier SuperSurf results for your exact username. ` +
        `If it expired after ${this._idleMin} min idle, its tabs are closed — call \`connect\` to start again.`,
        raw, 'unknown_username');
    }

    let result: any;
    try {
      result = await session.callTool(name, rest, options);
    } catch (err: any) {
      if (raw) throw err;
      result = { content: [{ type: 'text', text: `### Error\n\n${err?.message ?? String(err)}` }], isError: true };
    }
    if (name === 'disconnect') this._sessions.delete(username);
    return raw ? result : this._decorate(session, result);
  }

  private async _connect(username: string, rest: Record<string, unknown>, options: { rawResult?: boolean }): Promise<any> {
    if (username && USERNAME_RE.test(username) && (this._sessions.has(username) || this._connecting.has(username))) {
      return errorResult(`Username "${username}" is already in use by a live agent. Pick another username and call \`connect\` again.`, !!options.rawResult, 'username_in_use');
    }
    // Validation of empty / malformed names stays in onConnect (Task 4) — one copy of those texts.
    this._connecting.add(username);
    try {
      const session = new AgentSession(this._config);
      await session.initialize(this._server, this._clientInfo);
      const result = await session.callTool('connect', { ...rest, username }, options);
      if (session.state !== 'passive') this._sessions.set(username, session);
      return result;
    } finally {
      this._connecting.delete(username);
    }
  }

  /** Prepend the caller's header to the first text block unless it already names them. */
  private _decorate(session: AgentSession, result: any): any {
    const first = result?.content?.find?.((b: any) => b?.type === 'text');
    if (!first) return result;
    if (!first.text.includes(MARKER)) first.text = session.statusHeader() + first.text;
    return result;
  }

  async serverClosed(): Promise<void> {
    for (const s of this._sessions.values()) await s.serverClosed().catch(() => {});
    this._sessions.clear();
    await this._lobby.serverClosed();
  }
}
