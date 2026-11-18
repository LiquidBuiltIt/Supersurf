/**
 * Main-thread half of the engine-worker link. `attachEnginePort` listens on the
 * worker's port and routes each worker link through `SessionHost` with a port
 * sink, exactly like the socket branch in `ipc.ts`. Imports no engine code.
 *
 * Nothing in `main.ts` or the legacy socket path calls this yet (E2b wires it).
 *
 * @module engine-worker/main-side
 */
import type { SessionHost } from '../ipc';
import type { SessionSink } from '../types';
import type { MainToWorker, WorkerToMain } from './protocol';

/** The slice of `MessagePort` / `Worker` the main side needs. */
export interface EnginePort {
  postMessage(msg: MainToWorker): void;
  on(event: 'message', fn: (m: unknown) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  off(event: 'message', fn: (m: unknown) => void): unknown;
  off(event: 'close', fn: () => void): unknown;
}

/** Hooks for what E2b owns; every one is optional. */
export interface EnginePortHooks {
  ready?(): void;
  /** One MCP server line (UTF-8, no newline) for shim connection `cid`. */
  line?(cid: string, buf: Uint8Array): void;
  end?(cid: string): void;
  /** Answer an env lookup for `cid`: `value` for `get`, `keys` for `keys`. No hook: the worker gets an error. */
  env?(cid: string, op: 'get' | 'keys', name?: string): Promise<{ value?: string; keys?: string[] }>;
}

/** A sink that posts objects to the worker (no stringify); `end` posts `link-end`, then runs `onEnd`. */
export function portSink(port: Pick<EnginePort, 'postMessage'>, lid: number, onEnd?: () => void): SessionSink {
  return {
    send(msg) { port.postMessage({ t: 'msg', lid, msg: msg as Record<string, unknown> }); },
    end() { port.postMessage({ t: 'link-end', lid }); onEnd?.(); },
  };
}

/**
 * Attach the worker port to `host`. `detach()` (also run when the port closes)
 * closes every open link through `host.close`, so tabs are released.
 */
export function attachEnginePort(port: EnginePort, host: SessionHost, hooks: EnginePortHooks = {}): { detach(): void } {
  const links = new Map<number, { sessionId: string; sink: SessionSink }>();

  const onEnv = (m: Extract<WorkerToMain, { t: 'env' }>): void => {
    if (!hooks.env) {
      port.postMessage({ t: 'env-res', rid: m.rid, error: 'No env source for this connection' });
      return;
    }
    hooks.env(m.cid, m.op, m.name).then(
      (r) => port.postMessage({ t: 'env-res', rid: m.rid, value: r.value, keys: r.keys }),
      (e) => port.postMessage({ t: 'env-res', rid: m.rid, error: e?.message ?? String(e) }),
    );
  };

  const onMessage = (raw: unknown): void => {
    const m = raw as WorkerToMain | null;
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ready': hooks.ready?.(); break;
      case 'line': hooks.line?.(m.cid, m.buf); break;
      case 'end': hooks.end?.(m.cid); break;
      case 'link-open': {
        if (links.has(m.lid) || typeof m.sessionId !== 'string') break;
        // A socket's 'close' follows `end()` and closes the session; a port has no such event, so `end` closes it.
        const sink: SessionSink = portSink(port, m.lid, () => {
          const link = links.get(m.lid);
          if (link?.sink !== sink) return;
          links.delete(m.lid);
          host.close(link.sessionId, sink);
        });
        if (host.register(m.sessionId, sink)) links.set(m.lid, { sessionId: m.sessionId, sink });
        break;
      }
      case 'req': {
        const link = links.get(m.lid);
        if (link) host.request(link.sessionId, link.sink, m.msg).catch(() => {});
        break;
      }
      case 'link-close': {
        const link = links.get(m.lid);
        if (!link) break;
        links.delete(m.lid);
        host.close(link.sessionId, link.sink);
        break;
      }
      case 'status': port.postMessage({ t: 'status-res', rid: m.rid, status: host.buildStatusResponse() }); break;
      case 'env': onEnv(m); break;
    }
  };

  const detach = (): void => {
    port.off('message', onMessage);
    port.off('close', detach);
    for (const [lid, link] of [...links]) {
      links.delete(lid);
      host.close(link.sessionId, link.sink);
    }
  };

  port.on('message', onMessage);
  port.on('close', detach);
  return { detach };
}
