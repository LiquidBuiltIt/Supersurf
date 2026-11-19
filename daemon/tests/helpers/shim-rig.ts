/**
 * Test rig for the shim path: a fake engine module (a manager that opens links
 * through `host`), an inline worker (`startEngineSide` on a `MessageChannel`),
 * a fake shim (plain `net` client) and a recording worker for relay unit tests.
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { startEngineSide } from '../../src/engine-worker/worker';
import type { EngineModule } from '../../src/engine-worker/core';
import type { ShimWorker } from '../../src/shim-server';

/** What the fake manager saw, for assertions. */
export interface FakeEngineLog {
  configs: any[];
  managers: FakeManager[];
}

class FakeManager {
  links: any[] = [];
  closed = false;
  constructor(readonly config: any, readonly host: any, readonly log: FakeEngineLog, readonly closeDelayMs = 0) {
    log.managers.push(this);
  }
  async initialize(): Promise<void> {}
  async listTools(): Promise<unknown[]> {
    return ['connect', 'playbook', 'experiments', 'env_get', 'env_keys', 'status'].map((name) => ({
      name, description: name, inputSchema: { type: 'object', properties: {} },
    }));
  }
  async callTool(name: string, args: Record<string, any> = {}): Promise<any> {
    const text = async (): Promise<string> => {
      switch (name) {
        case 'connect':
        case 'playbook': { // a playbook run opens its own daemon session on the same connection
          this.links.push(await this.host.openLink({ clientId: args.client_id }));
          return 'connected';
        }
        case 'experiments': return JSON.stringify((await this.links.at(-1).sendCmd('experiments.get')).experiments);
        case 'env_get': return String(await this.host.envGet(args.name));
        case 'env_keys': return JSON.stringify(await this.host.envKeys());
        case 'status': return JSON.stringify(await this.host.queryDaemonStatus());
        default: throw new Error(`no tool ${name}`);
      }
    };
    try {
      return { content: [{ type: 'text', text: await text() }] };
    } catch (e: any) {
      return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
    }
  }
  async serverClosed(): Promise<void> {
    this.closed = true;
    if (this.closeDelayMs) await new Promise((r) => setTimeout(r, this.closeDelayMs));
    for (const l of this.links) await l.stop();
  }
}

/** `closeDelayMs` makes `serverClosed` slow, so a close is still in flight when the same shim re-registers. */
export function fakeEngine(closeDelayMs = 0): { engine: EngineModule; log: FakeEngineLog } {
  const log: FakeEngineLog = { configs: [], managers: [] };
  const engine = {
    AgentSessionManager: class extends FakeManager {
      constructor(config: any, host: any) { super(config, host, log, closeDelayMs); log.configs.push(config); }
    },
  } as unknown as EngineModule;
  return { engine, log };
}

/** `startEngineSide` on a `MessageChannel`: a `ShimWorker` without a thread. `terminate` closes both ends. */
export function inlineWorker(engine: EngineModule): ShimWorker & { terminated: boolean; terminate(): Promise<void> } {
  const { port1: mainEnd, port2: workerEnd } = new MessageChannel();
  const side = startEngineSide(workerEnd as any, engine);
  const w: any = mainEnd;
  w.terminated = false;
  w.terminate = async () => {
    w.terminated = true;
    await side.shutdown();
    mainEnd.close();
    workerEnd.close();
  };
  return w;
}

/** A worker that only records what main posts; tests `emit('message', ...)` as the worker. */
export class RecordingWorker extends EventEmitter {
  posted: any[] = [];
  terminated = false;
  /** Answer `shutdown` with `stopped` (a healthy worker); tests of the grace period turn it off. */
  autoStop = true;
  /** Answer `ping` with `pong`; heartbeat tests turn it on. */
  autoPong = false;
  postMessage(m: any): void {
    this.posted.push(m);
    if (m?.t === 'shutdown' && this.autoStop) setImmediate(() => this.emit('message', { t: 'stopped' }));
    if (m?.t === 'ping' && this.autoPong) setImmediate(() => this.emit('message', { t: 'pong' }));
  }
  terminate(): Promise<number> { this.terminated = true; return Promise.resolve(0); }
  of(t: string): any[] { return this.posted.filter((m) => m.t === t); }
}

export const wait = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await wait(5);
  }
}

export interface FakeShimOptions {
  sessionId?: string;
  env?: Record<string, string>;
  flags?: Record<string, unknown>;
  /** What `env.get` answers (the shim's own environment); `env.keys` answers `keys`. */
  answers?: Record<string, string>;
  keys?: string[];
  /** Skip answering env requests (timeout tests). */
  silent?: boolean;
  handshake?: Record<string, unknown>;
}

/** A plain `net` client that plays the Go shim: handshake, then lines in and out. */
export class FakeShim {
  socket!: net.Socket;
  lines: string[] = [];
  /** Control requests the daemon sent (env.get / env.keys), kept apart from MCP lines. */
  envRequests: string[] = [];
  ended = false;
  private buf = '';
  private nextId = 1;

  constructor(readonly sockPath: string, readonly opts: FakeShimOptions = {}) {}

  get sessionId(): string { return this.opts.sessionId ?? 'shim-0123456789abcdef'; }

  handshakeLine(): string {
    return JSON.stringify({
      type: 'shim_register', protocol: 1, mode: 'mcp', sessionId: this.sessionId, version: '0.0.1', cwd: '/x',
      flags: this.opts.flags ?? {}, env: this.opts.env ?? {}, caps: ['env.get', 'env.keys'], ...this.opts.handshake,
    }) + '\n';
  }

  async connect(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.socket = net.createConnection(this.sockPath);
      this.socket.once('connect', () => resolve());
      this.socket.once('error', reject);
    });
    this.socket.on('data', (d) => this.onData(d.toString()));
    this.socket.on('end', () => { this.ended = true; });
    this.socket.on('close', () => { this.ended = true; });
    return this;
  }

  /** Connect, send the handshake, wait for the first reply line and return it parsed. */
  async register(): Promise<any> {
    await this.connect();
    this.socket.write(this.handshakeLine());
    await until(() => this.lines.length > 0);
    return JSON.parse(this.lines[0]);
  }

  private onData(s: string): void {
    this.buf += s;
    let i: number;
    while ((i = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const msg = (() => { try { return JSON.parse(line); } catch { return null; } })();
      if (msg?.type === 'env.get' || msg?.type === 'env.keys') {
        this.envRequests.push(line);
        if (this.opts.silent) continue;
        const reply = msg.type === 'env.keys'
          ? { type: 'env.value', id: msg.id, keys: this.opts.keys ?? [] }
          : (msg.name in (this.opts.answers ?? {})
            ? { type: 'env.value', id: msg.id, name: msg.name, found: true, value: this.opts.answers![msg.name] }
            : { type: 'env.value', id: msg.id, name: msg.name, found: false });
        this.socket.write(JSON.stringify(reply) + '\n');
        continue;
      }
      this.lines.push(line);
    }
  }

  send(obj: unknown): void { this.socket.write(JSON.stringify(obj) + '\n'); }

  /** Send a JSON-RPC request and wait for the line with the same id. */
  async rpc(method: string, params: object = {}): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    await until(() => this.lines.some((l) => l.includes(`"id":${id},`) || l.includes(`"id":${id}}`)));
    return JSON.parse(this.lines.find((l) => l.includes(`"id":${id},`) || l.includes(`"id":${id}}`))!);
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  /** `tools/call`; returns the text of the first content item. */
  async call(name: string, args: object = {}): Promise<string> {
    const r = await this.rpc('tools/call', { name, arguments: args });
    if (!r.result) throw new Error(JSON.stringify(r));
    return r.result.content[0].text;
  }

  close(): void { this.socket.destroy(); }
}
