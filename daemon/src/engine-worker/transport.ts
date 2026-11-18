/**
 * An MCP SDK `Transport` over the engine-worker port, one per shim connection.
 * Inbound lines arrive through `feed`; outbound messages are stringified once,
 * encoded into a dedicated buffer and transferred (never cloned, never a pooled
 * Buffer slab: transferring a pool slab would detach it for every other Buffer).
 * Imports no engine code.
 *
 * @module engine-worker/transport
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { WorkerToMain } from './protocol';

export class PortTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private closed = false;

  constructor(
    private readonly cid: string,
    private readonly port: { postMessage(msg: WorkerToMain, transfer?: ArrayBuffer[]): void },
  ) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    const buf = new TextEncoder().encode(JSON.stringify(message));
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
    this.onmessage?.(msg);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
