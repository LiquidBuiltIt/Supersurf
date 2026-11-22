/**
 * ShimServer — the daemon side of the shim path (E2b). `IPCServer` hands over a
 * socket whose first line was `shim_register`; this validates the handshake,
 * starts the engine worker on first use, and relays NDJSON lines between the
 * socket and the worker. Main never parses MCP lines. Imports no engine code.
 *
 * Wire: `impl/shim-wire.md`. The shim connection is not a registry session: the
 * links the worker opens (agent `connect`, playbook runs) are.
 *
 * @module shim-server
 */
import path from 'path';
import type net from 'net';
import { Worker } from 'worker_threads';
import type { SessionHost } from './ipc';
import type { DaemonExperimentRegistry } from './experiments/index';
import { attachEnginePort, type EnginePort } from './engine-worker/main-side';
import { shimConfigInputs, enabledExperiments } from './engine-worker/shim-config';

/** The slice of `Worker` (or a `MessagePort` in tests) the shim server uses. */
export type ShimWorker = EnginePort & {
  on(event: 'exit' | 'error', fn: (...args: unknown[]) => void): unknown;
  terminate?(): unknown;
};

export interface ShimServerOptions {
  host: SessionHost;
  experiments: DaemonExperimentRegistry;
  daemon: { configPath: string; port: number; version: string };
  /** Starts the engine worker; called lazily at the first accepted `shim_register`. */
  startWorker?: () => ShimWorker;
  /** How long an `env.get` / `env.keys` waits for the shim (default 10 s). */
  envTimeoutMs?: number;
  /** Clock for the crash budget (default `Date.now`). */
  now?: () => number;
  /** Heartbeat period (default 5 s) and how long a silent worker is tolerated (default 15 s). */
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  /** Where crashes, bans, heartbeat kills and shutdown timeouts are logged. */
  log?: (msg: string) => void;
}

/** More than `CRASH_LIMIT` crashes within `CRASH_WINDOW_MS` bans shim sessions for `CRASH_BAN_MS`. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 5 * 60_000;
const CRASH_BAN_MS = 5 * 60_000;

interface Pending {
  op: 'get' | 'keys';
  resolve(r: { value?: string; keys?: string[] }): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

interface Conn {
  sessionId: string;
  socket: net.Socket;
  /** This connection's enabled experiments (H14), applied to every link it opens. */
  experiments: string[];
  pending: Map<number, Pending>;
}

/** Env names a shim session must not inherit from the daemon: its config comes from the handshake only. */
const SCRUBBED_ENV = new Set([
  'SUPERSURF_DEBUG',
  'SUPERSURF_EXPERIMENTS',
  'SUPERSURF_MULTI_AGENT',
  'SUPERSURF_SCREENSHOT_OMIT_PATH',
  'SUPERSURF_CONFIG_FILE',
  'SUPERSURF_PORT',
  'SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK',
]);

/** A copy of `env` without the names above and every `SUPERSURF_DISABLE_*`. */
export function workerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!SCRUBBED_ENV.has(k) && !k.startsWith('SUPERSURF_DISABLE_')) out[k] = v;
  }
  return out;
}

/** Production factory. Built layout: `dist/shim-server.js` finds `dist/engine-worker/worker.js`. */
export function startEngineWorker(): ShimWorker {
  return new Worker(path.join(__dirname, 'engine-worker', 'worker.js'), { env: workerEnv() }) as unknown as ShimWorker;
}

/** Calls `onLine` with each complete, non-empty line; keeps an unterminated tail (dropped at EOF, like the shim does). */
function lineSplitter(onLine: (line: Buffer) => void): (chunk: Buffer) => void {
  let parts: Buffer[] = [];
  return (chunk) => {
    let start = 0;
    let i: number;
    while ((i = chunk.indexOf(10, start)) !== -1) {
      const seg = chunk.subarray(start, i);
      const line = parts.length ? Buffer.concat([...parts, seg]) : seg;
      parts = [];
      start = i + 1;
      if (line.length) onLine(line);
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  };
}

export class ShimServer {
  /** By port cid (`<sessionId>#<seq>`): every accepted socket gets its own, so a late message of a closed socket never reaches a re-registered one. */
  private conns = new Map<string, Conn>();
  /** Live sockets by handshake sessionId, for the duplicate check only. */
  private live = new Map<string, Conn>();
  /** E9: daemon session id -> shim handshake id, for links opened `resumable: true` only. `main.ts` reads it to build the snapshot. */
  private resumable = new Map<string, string>();
  private nextSeq = 1;
  private _served = false;
  private worker: ShimWorker | null = null;
  private attached: { detach(): void } | null = null;
  private nextEnvId = 1;
  private readonly envTimeoutMs: number;
  private readonly now: () => number;
  private crashes: number[] = [];
  private bannedUntil = 0;
  private lastError = '';
  private stopping = false;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly opts: ShimServerOptions) {
    this.envTimeoutMs = opts.envTimeoutMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  private log(msg: string): void { this.opts.log?.(`[ShimServer] ${msg}`); }

  /** Count a crash of the current worker; the 4th within the window starts a ban. */
  private recordCrash(why: string): void {
    const now = this.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashes.push(now);
    this.lastError = why;
    this.log(`engine worker crashed: ${why}`);
    if (this.crashes.length > CRASH_LIMIT) {
      this.bannedUntil = now + CRASH_BAN_MS;
      this.log(`engine worker crashed ${this.crashes.length} times in 5 minutes; shim sessions banned until ${new Date(this.bannedUntil).toISOString()}`);
    }
  }

  /** Take over `socket` after its first line, `hs`, was `shim_register`. `rest` is what was already read after that line. */
  accept(socket: net.Socket, hs: any, rest: Buffer): void {
    const refuse = (reason: string): void => {
      socket.write(JSON.stringify({ type: 'shim_reject', reason }) + '\n');
      socket.end();
    };
    const sessionId = hs?.sessionId;
    if (this.stopping) return refuse('The daemon is shutting down');
    if (this.now() < this.bannedUntil) {
      return refuse(`The engine worker crashed ${this.crashes.length} times in 5 minutes; shim sessions are refused until ${new Date(this.bannedUntil).toISOString()}. Last error: ${this.lastError}`);
    }
    if (hs?.protocol !== 1) return refuse(`Unsupported shim protocol ${JSON.stringify(hs?.protocol)}; this daemon speaks 1`);
    if (hs.mode !== 'mcp') return refuse(`Unsupported shim mode ${JSON.stringify(hs.mode)}; this daemon accepts "mcp"`);
    if (typeof sessionId !== 'string' || !sessionId) return refuse('Handshake needs a sessionId string');
    if (this.live.has(sessionId)) return refuse(`Shim session "${sessionId}" is already connected`);

    let worker: ShimWorker;
    let inputs: ReturnType<typeof shimConfigInputs>;
    try {
      inputs = shimConfigInputs(hs, this.opts.daemon);
      worker = this.ensureWorker();
    } catch (e: any) {
      return refuse(`The daemon could not start the engine worker: ${e?.message ?? e}`);
    }

    const cid = `${sessionId}#${this.nextSeq++}`;
    const conn: Conn = { sessionId, socket, experiments: enabledExperiments(inputs), pending: new Map() };
    this.conns.set(cid, conn);
    this.live.set(sessionId, conn);
    const feed = lineSplitter((line) => this.onLine(cid, conn, line));
    socket.on('data', feed);
    socket.on('error', () => {});
    socket.on('close', () => {
      this.rejectPending(conn, 'The shim connection closed');
      if (this.live.get(sessionId) === conn) this.live.delete(sessionId);
      if (this.conns.get(cid) !== conn) return;
      this.conns.delete(cid);
      this.worker?.postMessage({ t: 'close', cid });
    });

    // G4: the shim's last tool-list hash; anything but a string of 1-128 chars is dropped, never refused.
    const th = typeof hs.toolsHash === 'string' && hs.toolsHash.length >= 1 && hs.toolsHash.length <= 128 ? hs.toolsHash : undefined;
    worker.postMessage({ t: 'open', cid, config: inputs, ...(th ? { toolsHash: th } : {}) });
    socket.write(JSON.stringify({ type: 'shim_ack', protocol: 1, version: this.opts.daemon.version }) + '\n');
    this._served = true;
    if (rest.length) feed(rest);
  }

  /** True once this daemon accepted a `shim_register` (sticky): the shim model is in use. */
  get served(): boolean { return this._served; }

  /** E9: the resumable daemon sessions and the shim connection each belongs to. */
  resumableSessions(): Array<{ id: string; shim: string }> {
    return [...this.resumable].map(([id, shim]) => ({ id, shim }));
  }

  /** Live shim sockets. */
  get liveCount(): number { return this.live.size; }

  /** Hand-off committed: tell every shim socket to reconnect at once (to the successor). */
  notifyRestarting(): void {
    for (const c of this.conns.values()) { if (c.socket.writable) c.socket.write('{"type":"restarting"}\n'); }
  }

  /**
   * Daemon shutdown: refuse new shims, ask the worker to close every connection
   * (its links close while the extension is still up), wait for `stopped` or
   * `graceMs`, then close what is left, end the sockets and terminate the worker.
   */
  async stop(graceMs = 2000): Promise<void> {
    this.stopping = true;
    const w = this.worker;
    if (w) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.log(`engine worker did not stop within ${graceMs} ms; terminating it`); resolve(); }, graceMs);
        timer.unref();
        const done = (): void => { clearTimeout(timer); resolve(); };
        w.on('message', (m: any) => { if (m?.t === 'stopped') done(); });
        w.on('exit', done);
        w.postMessage({ t: 'shutdown' });
      });
    }
    this.teardown();
    await w?.terminate?.();
  }

  private ensureWorker(): ShimWorker {
    if (this.worker) return this.worker;
    const w = (this.opts.startWorker ?? startEngineWorker)();
    this.worker = w;
    this.attached = attachEnginePort(w, this.opts.host, {
      line: (cid, buf) => {
        const c = this.conns.get(cid);
        if (!c || !c.socket.writable) return;
        c.socket.write(buf);
        c.socket.write('\n');
      },
      end: (cid) => { this.conns.get(cid)?.socket.end(); },
      env: (cid, op, name) => this.envRoundTrip(cid, op, name),
      registered: (sessionId, cid, resumable) => {
        const c = cid === undefined ? undefined : this.conns.get(cid);
        if (c) this.opts.experiments.initSession(sessionId, c.experiments);
        if (c && resumable === true) this.resumable.set(sessionId, c.sessionId);
      },
      closed: (sessionId) => { this.resumable.delete(sessionId); },
    });
    // A Worker emits exit/error, a MessagePort close: any of them means this worker is gone.
    // `counted`: an `error` is followed by its `exit`, which must not count again.
    let counted = false;
    const gone = (crashWhy?: string): void => {
      if (this.worker !== w) return;
      if (crashWhy && !counted && !this.stopping) { counted = true; this.recordCrash(crashWhy); }
      this.teardown();
    };
    // Exit 0 and 42 (debug `reload_mcp`) are not crashes.
    w.on('exit', (code) => gone(code === 0 || code === 42 ? undefined : `exit code ${code}`));
    w.on('error', (e: any) => gone(e?.message ?? String(e)));
    w.on('close', () => gone());

    const timeoutMs = this.opts.heartbeatTimeoutMs ?? 15_000;
    let lastPong = this.now();
    w.on('message', (m: any) => { if (m?.t === 'pong') lastPong = this.now(); });
    this.heartbeat = setInterval(() => {
      if (this.worker !== w) return;
      if (this.now() - lastPong > timeoutMs) {
        const why = `The engine worker did not answer a heartbeat in ${timeoutMs / 1000} s`;
        this.log(`${why}; terminating it`);
        gone(why);
        void w.terminate?.();
      } else {
        w.postMessage({ t: 'ping' });
      }
    }, this.opts.heartbeatMs ?? 5_000);
    this.heartbeat.unref();
    return w;
  }

  /** Detach from the worker (closing its links), end every shim socket and forget the worker. */
  private teardown(): void {
    this.worker = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.attached?.detach();
    this.attached = null;
    this.live.clear();
    this.resumable.clear();
    for (const [cid, conn] of [...this.conns]) {
      this.conns.delete(cid);
      this.rejectPending(conn, 'The engine worker stopped');
      conn.socket.end();
    }
  }

  private onLine(cid: string, conn: Conn, line: Buffer): void {
    const data = line.toString('utf8');
    // Control reply: parse only a line that can be one (the Go shim sorts map keys, so `type` is not first).
    if (data.charCodeAt(0) === 123 && data.includes('"env.value"')) {
      try {
        const v = JSON.parse(data);
        if (v?.type === 'env.value') {
          this.settleEnv(conn, v);
          return;
        }
      } catch { /* not JSON: an ordinary line, the worker reports it */ }
    }
    this.worker?.postMessage({ t: 'line', cid, data });
  }

  private settleEnv(conn: Conn, v: any): void {
    const p = typeof v.id === 'number' ? conn.pending.get(v.id) : undefined;
    if (!p) return;
    conn.pending.delete(v.id);
    clearTimeout(p.timer);
    if (p.op === 'keys') p.resolve({ keys: Array.isArray(v.keys) ? v.keys.filter((k: unknown) => typeof k === 'string') : [] });
    else p.resolve({ value: v.found === true && typeof v.value === 'string' ? v.value : undefined });
  }

  private rejectPending(conn: Conn, why: string): void {
    for (const [id, p] of [...conn.pending]) {
      conn.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
  }

  private envRoundTrip(cid: string, op: 'get' | 'keys', name?: string): Promise<{ value?: string; keys?: string[] }> {
    return new Promise((resolve, reject) => {
      const conn = this.conns.get(cid);
      if (!conn || !conn.socket.writable) return reject(new Error('The shim for this connection is gone'));
      const id = this.nextEnvId++;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`Timed out waiting for the shim to answer env.${op}`));
      }, this.envTimeoutMs);
      timer.unref();
      conn.pending.set(id, { op, resolve, reject, timer });
      conn.socket.write(JSON.stringify(op === 'get' ? { type: 'env.get', id, name } : { type: 'env.keys', id }) + '\n');
    });
  }
}
