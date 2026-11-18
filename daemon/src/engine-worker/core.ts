/**
 * Engine side of the engine-worker link: the connection table, the per-connection
 * `EngineHost` and the MCP SDK `Server` wiring. It takes the engine module as a
 * parameter and names no engine path, so `worker.ts` stays the only file that
 * does (see `engine-not-loaded.test.ts`).
 *
 * @module engine-worker/core
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ConfigService } from 'shared';
import { PortLinkRouter } from './port-link';
import { PortTransport } from './transport';
import type { MainToWorker, WorkerToMain } from './protocol';

/** The slice of the engine barrel the worker uses. */
export interface EngineModule {
  AgentSessionManager: new (config: any, host: any) => {
    initialize(server: any, clientInfo: Record<string, unknown>): Promise<void>;
    listTools(): Promise<unknown[]>;
    callTool(name: string, args?: Record<string, unknown>): Promise<any>;
    serverClosed(): Promise<void>;
  };
}

/** The slice of `MessagePort` (or `parentPort`) the engine side needs. */
export interface WorkerPort {
  postMessage(msg: WorkerToMain, transfer?: ArrayBuffer[]): void;
  on(event: 'message', fn: (m: MainToWorker) => void): unknown;
}

const REPLY_TIMEOUT_MS = 10_000;

interface Connection {
  transport: PortTransport;
  server: Server;
  /** Resolves when the SDK server is connected; lines and `close` wait on it so they keep their order. */
  ready: Promise<void>;
}

/**
 * `config` arrives through structured clone, which strips the `ConfigService`
 * prototype (its fields survive). Put it back so `.get()` works in the engine.
 */
function reviveConfig(config: any): any {
  const cs = config?.configService;
  if (cs && typeof cs.get !== 'function') Object.setPrototypeOf(cs, ConfigService.prototype);
  return config;
}

export function createEngineSide(port: WorkerPort, engine: EngineModule): { shutdown(): Promise<void> } {
  const router = new PortLinkRouter(port);
  const connections = new Map<string, Connection>();
  const managers = new Map<string, InstanceType<EngineModule['AgentSessionManager']>>();
  let nextRid = 1;
  const replies = new Map<number, (m: any) => void>();

  /** One request/reply round trip over the port; `null` on timeout. */
  const ask = (build: (rid: number) => WorkerToMain): Promise<any | null> =>
    new Promise((resolve) => {
      const rid = nextRid++;
      const timer = setTimeout(() => { replies.delete(rid); resolve(null); }, REPLY_TIMEOUT_MS);
      replies.set(rid, (m) => { clearTimeout(timer); resolve(m); });
      port.postMessage(build(rid));
    });

  const makeHost = (cid: string, config: any) => {
    const env = async (op: 'get' | 'keys', name?: string) => {
      const r = await ask((rid) => ({ t: 'env', rid, cid, op, name }));
      if (!r) throw new Error('Timed out waiting for the shim to answer an env request');
      if (r.error) throw new Error(r.error);
      return r;
    };
    return {
      packageVersion: config.server.version as string,
      // The daemon is in-process behind the port: spawn and version-guard options do not apply.
      openLink: (opts: { clientId: string }) => router.open(opts.clientId),
      queryDaemonStatus: async () => (await ask((rid) => ({ t: 'status', rid })))?.status ?? null,
      runConfig: () => ({ ...config }),
      envGet: async (name: string) => (await env('get', name)).value as string | undefined,
      envKeys: async () => ((await env('keys')).keys ?? []) as string[],
    };
  };

  const open = (cid: string, rawConfig: unknown): void => {
    if (connections.has(cid)) return;
    const config = reviveConfig(rawConfig);
    const manager = new engine.AgentSessionManager(config, makeHost(cid, config));
    const transport = new PortTransport(cid, port);
    // Same wiring as server/src/cli.ts.
    const server = new Server(
      { name: config.server.name, version: config.server.version },
      { capabilities: { tools: { listChanged: true }, logging: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await manager.listTools()) as any }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return await manager.callTool(name, args ?? {});
    });
    const ready = manager.initialize(server, {}).then(() => server.connect(transport));
    connections.set(cid, { transport, server, ready });
    managers.set(cid, manager);
    ready.catch(() => { void close(cid); });
  };

  const close = async (cid: string): Promise<void> => {
    const conn = connections.get(cid);
    const manager = managers.get(cid);
    if (!conn || !manager) return;
    connections.delete(cid);
    managers.delete(cid);
    await conn.ready.catch(() => {});
    try {
      await manager.serverClosed();
      await conn.server.close();
    } catch { /* best effort: the connection is gone either way */ }
    port.postMessage({ t: 'end', cid });
  };

  const shutdown = async (): Promise<void> => {
    await Promise.all([...connections.keys()].map(close));
  };

  port.on('message', (m) => {
    if (router.handle(m)) return;
    switch (m.t) {
      case 'open': open(m.cid, m.config); break;
      case 'line': {
        const conn = connections.get(m.cid);
        if (conn) conn.ready.then(() => conn.transport.feed(m.data), () => {});
        break;
      }
      case 'close': void close(m.cid); break;
      case 'shutdown': void shutdown(); break;
      case 'status-res': replies.get(m.rid)?.(m); replies.delete(m.rid); break;
      case 'env-res': replies.get(m.rid)?.(m); replies.delete(m.rid); break;
    }
  });

  return { shutdown };
}
