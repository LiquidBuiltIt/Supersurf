import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createEngineSide } from '../src/engine-worker/core';

/** G4 (E4): the tool-change notice at transport level, with a fake engine on a hand-driven port. */
const CHANGED = 'SuperSurf tools changed; run `/mcp reconnect supersurf` to see them.';
const sha = (tools: unknown) => createHash('sha256').update(JSON.stringify(tools)).digest('hex');
const TOOLS = [{ name: 'connect', inputSchema: { type: 'object' } }];
const INIT = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } };

function rig(toolsHash?: string, tools: unknown[] = TOOLS) {
  let onMsg!: (m: any) => void;
  const posted: any[] = [];
  const port = { postMessage: (m: any) => { posted.push(m); }, on: (_e: string, fn: any) => { onMsg = fn; } };
  class Mgr {
    constructor(_c: any, _h: any) {}
    async initialize() {}
    async listTools() { return tools; }
    async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; }
    async serverClosed() {}
  }
  createEngineSide(port, { AgentSessionManager: Mgr } as any);
  onMsg({ t: 'open', cid: 'c1', config: { cli: {}, env: {}, file: {}, port: 5555, version: '0' }, ...(toolsHash ? { toolsHash } : {}) });
  /** Every line posted for c1, decoded, in order. */
  const lines = () => posted.filter((m) => m.t === 'line').map((m) => JSON.parse(Buffer.from(m.buf).toString()));
  const send = (msg: object) => onMsg({ t: 'line', cid: 'c1', data: JSON.stringify(msg) });
  const settle = () => new Promise<void>((r) => setTimeout(r, 60));
  const call = async (id: number, method: string, params: object = {}) => {
    send({ jsonrpc: '2.0', id, method, params });
    await vi_waitFor(() => lines().some((l) => l.id === id));
    return lines().find((l) => l.id === id);
  };
  return { lines, send, settle, call };
}

async function vi_waitFor(pred: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const listChanged = (ls: any[]) => ls.filter((l) => l.method === 'notifications/tools/list_changed');
const hashes = (ls: any[]) => ls.filter((l) => l.type === 'tools_hash');

describe('G4 (a): list_changed after the replay answer', () => {
  it('sends it exactly once, after the answer to id "__shim_init__"', async () => {
    const r = rig();
    await r.call('__shim_init__' as any, 'initialize', INIT);
    await r.settle();
    const ls = r.lines();
    expect(listChanged(ls)).toHaveLength(1);
    expect(ls.findIndex((l) => l.method === 'notifications/tools/list_changed')).toBe(ls.findIndex((l) => l.id === '__shim_init__') + 1);
  });

  it('sends none for a normal initialize id', async () => {
    const r = rig();
    await r.call(1, 'initialize', INIT);
    await r.settle();
    expect(listChanged(r.lines())).toHaveLength(0);
  });
});

describe('G4 (b): tools_hash control line after tools/list', () => {
  it('follows every tools/list answer with the sha256 of JSON.stringify(result.tools)', async () => {
    const r = rig();
    await r.call(1, 'initialize', INIT);
    await r.call(2, 'tools/list');
    await r.call(3, 'tools/list');
    await r.settle();
    const ls = r.lines();
    expect(hashes(ls)).toEqual([{ type: 'tools_hash', hash: sha(TOOLS) }, { type: 'tools_hash', hash: sha(TOOLS) }]);
    expect(ls.findIndex((l) => l.type === 'tools_hash')).toBe(ls.findIndex((l) => l.id === 2) + 1);
  });

  it('sends none for other requests', async () => {
    const r = rig();
    await r.call(1, 'initialize', INIT);
    await r.call(2, 'tools/call', { name: 'connect', arguments: {} });
    await r.settle();
    expect(hashes(r.lines())).toHaveLength(0);
  });
});

describe('G4 (e): fallback notice on the first tools/call', () => {
  const texts = (res: any) => res.result.content.map((c: any) => c.text);

  it('a differing toolsHash adds one text block to the first call only', async () => {
    const r = rig('0'.repeat(64));
    await r.call(1, 'initialize', INIT);
    expect(texts(await r.call(2, 'tools/call', { name: 'connect', arguments: {} }))).toEqual(['ok', CHANGED]);
    expect(texts(await r.call(3, 'tools/call', { name: 'connect', arguments: {} }))).toEqual(['ok']);
  });

  it('a tools/list before the first call suppresses it', async () => {
    const r = rig('0'.repeat(64));
    await r.call(1, 'initialize', INIT);
    await r.call(2, 'tools/list');
    expect(texts(await r.call(3, 'tools/call', { name: 'connect', arguments: {} }))).toEqual(['ok']);
  });

  it('an equal hash adds nothing', async () => {
    const r = rig(sha(TOOLS));
    await r.call(1, 'initialize', INIT);
    expect(texts(await r.call(2, 'tools/call', { name: 'connect', arguments: {} }))).toEqual(['ok']);
  });

  it('no toolsHash adds nothing', async () => {
    const r = rig();
    await r.call(1, 'initialize', INIT);
    expect(texts(await r.call(2, 'tools/call', { name: 'connect', arguments: {} }))).toEqual(['ok']);
  });
});
