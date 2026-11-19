/**
 * An MCP SDK `Transport` over the engine-worker port, one per shim connection.
 * Inbound lines arrive through `feed`; outbound messages are stringified once,
 * encoded into a dedicated buffer and transferred (never cloned, never a pooled
 * Buffer slab: transferring a pool slab would detach it for every other Buffer).
 * Imports no engine code.
 *
 * @module engine-worker/transport
 */
import { createHash } from 'crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { WorkerToMain } from './protocol';

/** The G4 tool-list fingerprint: sha256 hex of `JSON.stringify(tools)`. */
export function toolsHash(tools: unknown): string {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex');
}

/** A shim replay (`initialize` on the reserved id): its answer is followed by `list_changed` (G4). */
const REPLAY_ID = '__shim_init__';

export class PortTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private closed = false;
  /** Ids of requests whose answer gets a G4 follow-up line. */
  private replayIds = new Set<unknown>();
  private listIds = new Set<unknown>();

  constructor(
    private readonly cid: string,
    private readonly port: { postMessage(msg: WorkerToMain, transfer?: ArrayBuffer[]): void },
  ) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    this.post(message);
    const m = message as { id?: unknown; result?: any; error?: unknown };
    if (m.id === undefined || (!m.result && !m.error)) return;
    // Any reply, result or error, ends the id's bookkeeping.
    const replay = this.replayIds.delete(m.id);
    const list = this.listIds.delete(m.id);
    // G4, shim only: after a result, never before it.
    if (replay && m.result) this.post({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    if (list && Array.isArray(m.result?.tools)) this.post({ type: 'tools_hash', hash: toolsHash(m.result.tools) });
  }

  private post(obj: object): void {
    const buf = new TextEncoder().encode(JSON.stringify(obj));
    this.port.postMessage({ t: 'line', cid: this.cid, buf }, [buf.buffer as ArrayBuffer]);
  }

  /** One client line from main. A malformed line is an error event, never a throw. */
  feed(data: string): void {
    let msg: JSONRPCMessage;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      this.onerror?.(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const req = msg as { id?: unknown; method?: unknown };
    if (req.id !== undefined) {
      if (req.method === 'initialize' && req.id === REPLAY_ID) this.replayIds.add(req.id);
      else if (req.method === 'tools/list') this.listIds.add(req.id);
    }
    this.onmessage?.(msg);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
