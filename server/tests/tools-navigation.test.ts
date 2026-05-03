import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onBrowserTabs, onNavigate } from '../src/tools/navigation';
import type { ToolContext } from '../src/tools/lib/types';

// Mock experimental registry
vi.mock('../src/experimental/index', () => ({
  experimentRegistry: {
    isEnabled: vi.fn().mockReturnValue(false),
  },
}));

function createMockCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({ success: true }) } as any,
    connectionManager: {
      setAttachedTab: vi.fn(),
      setStealthMode: vi.fn(),
      clearAttachedTab: vi.fn(),
      attachedTab: null,
    },
    cdp: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn().mockResolvedValue({ x: 100, y: 100 }),
    getSelectorExpression: vi.fn((s: string) => `document.querySelector("${s}")`),
    findAlternativeSelectors: vi.fn().mockResolvedValue([]),
    formatResult: vi.fn((_name, result, _opts) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] })),
    error: vi.fn((msg, _opts) => ({ content: [{ type: 'text', text: msg }], isError: true })),
    ...overrides,
  };
}

describe('onBrowserTabs()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('sends getTabs for list action', async () => {
    await onBrowserTabs(ctx, { action: 'list' }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('getTabs', {});
  });

  it('sends createTab for new action', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ attachedTab: { id: 1 } });
    await onBrowserTabs(ctx, { action: 'new', url: 'https://example.com' }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('createTab', expect.objectContaining({ url: 'https://example.com' }));
  });

  it('sends selectTab for attach action', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ attachedTab: { id: 1 } });
    await onBrowserTabs(ctx, { action: 'attach', index: 0 }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('selectTab', expect.objectContaining({ index: 0 }));
  });

  it('sends closeTab for close action', async () => {
    await onBrowserTabs(ctx, { action: 'close', index: 0 }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('closeTab', 0);
  });

  it('returns error for unknown action', async () => {
    await onBrowserTabs(ctx, { action: 'explode' }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('Unknown tab action'), expect.anything());
  });
});

describe('onNavigate()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('navigates to URL', async () => {
    await onNavigate(ctx, { action: 'url', url: 'https://example.com' }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('navigate', expect.objectContaining({ action: 'url', url: 'https://example.com' }));
  });

  it('navigates back via history', async () => {
    (ctx.eval as any).mockResolvedValue('https://prev.com');
    await onNavigate(ctx, { action: 'back' }, {});
    expect(ctx.eval).toHaveBeenCalledWith('window.history.back()');
    expect(ctx.sleep).toHaveBeenCalledWith(1500);
  });

  it('navigates forward via history', async () => {
    (ctx.eval as any).mockResolvedValue('https://next.com');
    await onNavigate(ctx, { action: 'forward' }, {});
    expect(ctx.eval).toHaveBeenCalledWith('window.history.forward()');
    expect(ctx.sleep).toHaveBeenCalledWith(1500);
  });

  it('reloads the page', async () => {
    await onNavigate(ctx, { action: 'reload' }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('navigate', { action: 'reload' });
  });

  it('returns error for unknown action', async () => {
    await onNavigate(ctx, { action: 'teleport' }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('Unknown navigate action'), expect.anything());
  });

  it('forwards screenshotData from navigate result', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      success: true, url: 'https://example.com',
      screenshotData: 'fakeBase64', screenshotMimeType: 'image/jpeg',
    });
    const result = await onNavigate(ctx, { action: 'url', url: 'https://example.com', screenshot: true }, {});
    expect(result._screenshotData).toBe('fakeBase64');
    expect(result._screenshotMimeType).toBe('image/jpeg');
  });

  it('passes screenshot and smartWait params to navigate command', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ success: true, url: 'https://example.com' });
    await onNavigate(ctx, { action: 'url', url: 'https://example.com', screenshot: true }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('navigate', expect.objectContaining({
      screenshot: true,
      smartWait: false, // experiments are mocked as disabled
    }));
  });
});
