import { describe, it, expect, vi, beforeEach } from 'vitest';
import { callToolHandler } from '../src/tools/lib/handler-registry';

// Mock the experimental registry
vi.mock('../src/experimental/index', () => ({
  callExperimentalTool: vi.fn().mockReturnValue(null),
}));

// Mock tips
vi.mock('../src/tips', () => ({
  getTip: () => null,
}));

function makeCtx(url = 'https://example.com/'): any {
  const connectionManager = {
    getAttachedTab: () => ({ url, id: 1 }),
    statusHeader: () => '',
  };

  return {
    ext: {
      sendCmd: vi.fn().mockResolvedValue({ tabs: [{ id: 1, url, attached: true }], attachedTabId: 1 }),
      consumeDialogEvents: vi.fn().mockReturnValue([]),
    },
    connectionManager,
    config: { get: () => ({ tips: false }) },
    sleep: vi.fn(),
    formatResult: (name: string, result: any, options: any) => {
      if (options?.rawResult) return result;
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text }] };
    },
    error: (m: string, options?: any) => {
      if (options?.rawResult) return { success: false, error: m };
      return { content: [{ type: 'text', text: m }], isError: true };
    },
  };
}

describe('callToolHandler', () => {
  it('returns null for an unknown tool name', async () => {
    const res = await callToolHandler(makeCtx(), 'no_such_tool', {}, {});
    expect(res).toBeNull();
  });

  it('returns null for playbooks (owned by the dispatcher, not the registry)', async () => {
    const res = await callToolHandler(makeCtx(), 'playbooks', { action: 'history' }, {});
    expect(res).toBeNull();
  });

  it('routes a known tool to its handler', async () => {
    const ctx = makeCtx();
    const res = await callToolHandler(ctx, 'browser_tabs', { action: 'list' }, { rawResult: true });
    expect(res).not.toBeNull();
    expect(ctx.ext.sendCmd).toHaveBeenCalled();
  });
});
