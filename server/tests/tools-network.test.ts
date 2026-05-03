import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onNetworkRequests, onConsoleMessages } from '../src/tools/network';
import type { ToolContext } from '../src/tools/lib/types';

function createMockCtx(): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({}) } as any,
    connectionManager: null,
    cdp: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn(),
    getSelectorExpression: vi.fn(),
    findAlternativeSelectors: vi.fn(),
    formatResult: vi.fn((_n, r) => ({ content: [{ type: 'text', text: JSON.stringify(r) }] })),
    error: vi.fn((msg) => ({ content: [{ type: 'text', text: msg }], isError: true })),
  };
}

describe('onNetworkRequests()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('lists network requests', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      requests: [
        { requestId: '1', url: 'https://api.com/data', method: 'GET', statusCode: 200 },
        { requestId: '2', url: 'https://api.com/auth', method: 'POST', statusCode: 401 },
      ],
    });

    const result = await onNetworkRequests(ctx, { action: 'list' }, {});
    expect(result.content[0].text).toContain('https://api.com/data');
    expect(result.content[0].text).toContain('https://api.com/auth');
  });

  it('filters by URL pattern', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      requests: [
        { requestId: '1', url: 'https://api.com/data', method: 'GET' },
        { requestId: '2', url: 'https://cdn.com/image.png', method: 'GET' },
      ],
    });

    const result = await onNetworkRequests(ctx, { action: 'list', urlPattern: 'api.com' }, { rawResult: true });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].url).toContain('api.com');
  });

  it('filters by method', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      requests: [
        { requestId: '1', method: 'GET' },
        { requestId: '2', method: 'POST' },
      ],
    });

    const result = await onNetworkRequests(ctx, { action: 'list', method: 'POST' }, { rawResult: true });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].method).toBe('POST');
  });

  it('filters by status code', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      requests: [
        { requestId: '1', statusCode: 200 },
        { requestId: '2', statusCode: 404 },
      ],
    });

    const result = await onNetworkRequests(ctx, { action: 'list', status: 404 }, { rawResult: true });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].statusCode).toBe(404);
  });

  it('clears network requests', async () => {
    const result = await onNetworkRequests(ctx, { action: 'clear' }, { rawResult: true });
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('clearNetwork', {});
    expect(result.success).toBe(true);
  });

  it('shows details for specific request', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      requests: [{ requestId: 'abc', url: 'https://api.com', statusCode: 200, method: 'GET' }],
    });

    const result = await onNetworkRequests(ctx, { action: 'details', requestId: 'abc' }, { rawResult: true });
    expect(result.requestId).toBe('abc');
  });

  it('returns error for missing request ID on details', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ requests: [] });
    await onNetworkRequests(ctx, { action: 'details', requestId: 'missing' }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('Request not found'), expect.anything());
  });

  it('handles empty request list', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ requests: [] });
    const result = await onNetworkRequests(ctx, {}, {});
    expect(result.content[0].text).toContain('No network requests');
  });

  it('paginates with offset and limit', async () => {
    const requests = Array.from({ length: 30 }, (_, i) => ({ requestId: `${i}`, url: `https://r${i}.com` }));
    (ctx.ext.sendCmd as any).mockResolvedValue({ requests });

    const result = await onNetworkRequests(ctx, { action: 'list', offset: 5, limit: 3 }, { rawResult: true });
    expect(result.requests).toHaveLength(3);
    expect(result.total).toBe(30);
    expect(result.offset).toBe(5);
  });
});

describe('onConsoleMessages()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('returns console messages', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      messages: [
        { level: 'log', text: 'Hello world' },
        { level: 'error', text: 'Something broke' },
      ],
    });

    const result = await onConsoleMessages(ctx, {}, {});
    expect(result.content[0].text).toContain('[log] Hello world');
    expect(result.content[0].text).toContain('[error] Something broke');
  });

  it('filters by level', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      messages: [
        { level: 'log', text: 'info msg' },
        { level: 'error', text: 'err msg' },
      ],
    });

    const result = await onConsoleMessages(ctx, { level: 'error' }, { rawResult: true });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].level).toBe('error');
  });

  it('filters by text', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      messages: [
        { level: 'log', text: 'Loading complete' },
        { level: 'log', text: 'Error occurred' },
      ],
    });

    const result = await onConsoleMessages(ctx, { text: 'error' }, { rawResult: true });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toContain('Error occurred');
  });

  it('handles empty messages', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ messages: [] });
    const result = await onConsoleMessages(ctx, {}, {});
    expect(result.content[0].text).toContain('No console messages');
  });
});
