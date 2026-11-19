/**
 * Messages between the daemon's main thread and the engine worker, over one
 * `MessagePort`. Types only: no runtime code, so both sides import it freely.
 *
 * `cid` is a shim connection, `lid` a daemon-session link opened by the worker
 * (a connect session or a playbook run), `rid` one request/reply round trip.
 *
 * @module engine-worker/protocol
 */

import type { ShimConfigInputs } from './shim-config';

/** A JSON-RPC request as `DaemonClient.sendCmd` writes it; main feeds it to `SessionHost.request`. */
export interface LinkRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
  timeout: number;
}

export type MainToWorker =
  /** `config` is plain-object inputs from the handshake; the worker builds the `ConfigService` and `BackendConfig`. `resume` is reserved. */
  | { t: 'open'; cid: string; config: ShimConfigInputs; resume?: unknown }
  | { t: 'line'; cid: string; data: string }
  | { t: 'close'; cid: string }
  | { t: 'shutdown' }
  /** Heartbeat: the worker answers `pong` at once. */
  | { t: 'ping' }
  /** One object a port sink was sent: session_ack, session_reject, or a JSON-RPC response with `config_drift`/`peers`. */
  | { t: 'msg'; lid: number; msg: Record<string, unknown> }
  | { t: 'link-end'; lid: number }
  | { t: 'status-res'; rid: number; status: unknown }
  | { t: 'env-res'; rid: number; value?: string; keys?: string[]; error?: string };

export type WorkerToMain =
  | { t: 'ready' }
  | { t: 'pong' }
  /** Posted by `shutdown` after every connection is closed. */
  | { t: 'stopped' }
  /** One MCP server line, UTF-8, transferred (never a pooled Buffer slab). */
  | { t: 'line'; cid: string; buf: Uint8Array }
  | { t: 'end'; cid: string }
  | { t: 'link-open'; lid: number; sessionId: string; cid?: string }
  | { t: 'req'; lid: number; msg: LinkRequest }
  | { t: 'link-close'; lid: number }
  | { t: 'status'; rid: number }
  | { t: 'env'; rid: number; cid: string; op: 'get' | 'keys'; name?: string };
