import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dispatchTool } from '../src/tools/lib/dispatcher';
import { trailFor, _resetTrailsForTest } from '../src/playbooks/trail';

function makeCtx(): any {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({ tabs: [], attachedTabId: 1 }) },
    agentSession: { getAttachedTab: () => ({ url: 'https://example.com/page' }), clientId: 'test' },
    config: { get: () => ({ tips: false }) },
    cdp: vi.fn(),
    eval: vi.fn(),
    sleep: vi.fn(),
    getElementCenter: vi.fn(),
    getSelectorExpression: (s: string) => s,
    findAlternativeSelectors: vi.fn(),
    formatResult: (_n: string, r: any) => ({ content: [{ type: 'text', text: String(r) }] }),
    error: (m: string) => ({ content: [{ type: 'text', text: m }], isError: true }),
  };
}

const env = { metricsLogger: null, clientId: 'test', getCurrentUrl: () => 'https://example.com/page' };

describe('dispatchTool — per-call action ids', () => {
  beforeEach(() => { _resetTrailsForTest(); });

  it('prefixes an id onto a non-interact tool result', async () => {
    const ctx = makeCtx();
    const res = await dispatchTool(ctx, 'browser_snapshot', {}, {}, env);
    expect(res.content[0].text).toMatch(/^#1 /);
  });

  it('records the call in the trail with its tool name and url', async () => {
    const ctx = makeCtx();
    await dispatchTool(ctx, 'browser_snapshot', {}, {}, env);
    const entry = trailFor('test').get(1)!;
    expect(entry.tool).toBe('browser_snapshot');
    expect(entry.type).toBe('browser_snapshot');
    expect(entry.url).toBe('https://example.com/page');
  });

  it('does NOT record a per-call entry for browser_interact', async () => {
    // browser_interact records per-action inside onInteract. A call-level entry
    // here would double-count every interact: N action entries plus one call entry.
    const ctx = makeCtx();
    await dispatchTool(ctx, 'browser_interact', { actions: [] }, {}, env);
    expect(trailFor('test').size()).toBe(0);
  });

  it('does not prefix in rawResult mode, but still records the call', async () => {
    // script-mode (--script-mode) passes rawResult: true for every call. The
    // trail still needs the entry so `playbooks history`/`run` see it there too —
    // only the visible `#<id> ` text prefix is script-mode-specific.
    const ctx = makeCtx();
    const res = await dispatchTool(ctx, 'browser_snapshot', {}, { rawResult: true }, env);
    if (res?.content?.[0]?.type === 'text') {
      expect(res.content[0].text).not.toMatch(/^#\d+ /);
    }
    expect(trailFor('test').size()).toBe(1);
  });

  it('records an error outcome when the tool throws', async () => {
    const ctx = makeCtx();
    ctx.ext.sendCmd = vi.fn().mockRejectedValue(new Error('boom'));
    await dispatchTool(ctx, 'browser_snapshot', {}, {}, env);
    expect(trailFor('test').get(1)!.outcome).toBe('error');
  });
});
