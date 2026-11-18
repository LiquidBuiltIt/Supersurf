import { describe, it, expect } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { PortTransport } from '../src/engine-worker/transport';

/** A real port, with the posted message captured so the test can inspect the sender's buffer afterwards. */
function rig() {
  const { port1, port2 } = new MessageChannel();
  const posted: any[] = [];
  const transport = new PortTransport('c1', {
    postMessage: (m, transfer) => { posted.push(m); port1.postMessage(m, transfer as any); },
  });
  return { transport, posted, close: () => { port1.close(); port2.close(); }, port2 };
}

describe('engine worker transfer (decision 5)', () => {
  it('a 200 KB line is transferred: the sender buffer is detached', async () => {
    const { transport, posted, close } = rig();
    await transport.send({ jsonrpc: '2.0', id: 1, result: { data: 'x'.repeat(200_000) } });
    expect(posted[0].t).toBe('line');
    expect(posted[0].buf.byteLength).toBe(0);
    close();
  });

  it('a 100-byte line leaves the Buffer pool usable', async () => {
    const { transport, posted, port2, close } = rig();
    const pooled = Buffer.from('still readable'); // small Buffer.from comes from the shared pool slab
    const received = new Promise<Uint8Array>((r) => port2.once('message', (m) => r(m.buf)));
    await transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });

    expect(pooled.toString()).toBe('still readable');
    expect(Buffer.from('new').toString()).toBe('new');
    expect(Buffer.allocUnsafe(8).length).toBe(8);
    // the transferred bytes are a dedicated buffer, exactly the line
    expect(Buffer.from(await received).toString()).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    expect(posted[0].buf.byteLength).toBe(0);
    close();
  });

  it('a line from main parses into onmessage; a parse error goes to onerror and never throws', () => {
    const { transport, close } = rig();
    const got: unknown[] = [];
    const errs: Error[] = [];
    transport.onmessage = (m) => { got.push(m); };
    transport.onerror = (e) => { errs.push(e); };
    transport.feed('{"jsonrpc":"2.0","id":2,"method":"ping"}');
    expect(() => transport.feed('{nope')).not.toThrow();
    expect(got).toEqual([{ jsonrpc: '2.0', id: 2, method: 'ping' }]);
    expect(errs).toHaveLength(1);
    close();
  });
});
