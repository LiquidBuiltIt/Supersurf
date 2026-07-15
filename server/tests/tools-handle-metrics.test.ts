import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserBridge } from '../src/tools';
import { setBaseDirForTests } from '../src/experimental/fingerprinting/store';
import { experimentRegistry } from '../src/experimental/index';

const FP = JSON.stringify({
  role: 'textbox', name: 'First name', text: '', tag: 'input', type: 'text',
  attrs: {}, classList: [], htmlId: 'fn', ordinal: 0, cx: 10, cy: 20,
  neighborText: '', landmark: '', selector: '#fn',
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-fp-'));
  setBaseDirForTests(tmp);
  experimentRegistry.enable('fingerprinting');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  experimentRegistry.disable('fingerprinting');
});

describe('BrowserBridge — handle event emission', () => {
  it('writes a handle.capture metrics entry when a named element resolves via ctx.getElementCenter', async () => {
    const writes: any[] = [];
    const metricsLogger: any = { write: (e: any) => writes.push(e) };

    // Extension transport: first Runtime.evaluate call is the getElementCenter
    // rect read (returns {x,y}); second is the fire-and-forget fingerprint capture
    // (returns the serialized fingerprint JSON).
    let call = 0;
    const ext: any = {
      sendCmd: vi.fn(async () => {
        call += 1;
        return { result: { value: call === 1 ? { x: 10, y: 20 } : FP } };
      }),
    };

    const connectionManager: any = {
      clientId: 'test',
      getAttachedTab: () => ({ url: 'https://ashbyhq.com/apply' }),
    };

    const bridge = new BrowserBridge({}, ext);
    await bridge.initialize({}, {}, connectionManager, metricsLogger);

    const ctx = (bridge as any).buildContext(undefined);
    const center = await ctx.getElementCenter('#fn', { name: 'First Name', purpose: 'enter name' });
    expect(center).toEqual({ x: 10, y: 20 });

    // Capture is fire-and-forget inside resolveWithHealing; flush microtasks/timers.
    await new Promise((r) => setTimeout(r, 10));

    const handleWrites = writes.filter((w) => w.tool === 'handle');
    expect(handleWrites.length).toBeGreaterThanOrEqual(1);
    expect(handleWrites[0].params).toMatchObject({ event: 'handle.capture', name: 'first_name' });
  });

  it('does not write a handle event when no meta name is supplied', async () => {
    const writes: any[] = [];
    const metricsLogger: any = { write: (e: any) => writes.push(e) };

    let call = 0;
    const ext: any = {
      sendCmd: vi.fn(async () => {
        call += 1;
        return { result: { value: call === 1 ? { x: 10, y: 20 } : FP } };
      }),
    };

    const connectionManager: any = {
      clientId: 'test',
      getAttachedTab: () => ({ url: 'https://ashbyhq.com/apply' }),
    };

    const bridge = new BrowserBridge({}, ext);
    await bridge.initialize({}, {}, connectionManager, metricsLogger);

    const ctx = (bridge as any).buildContext(undefined);
    await ctx.getElementCenter('#fn');

    await new Promise((r) => setTimeout(r, 10));

    const handleWrites = writes.filter((w) => w.tool === 'handle');
    expect(handleWrites.length).toBe(0);
  });
});
