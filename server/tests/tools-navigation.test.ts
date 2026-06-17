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

  it('forwards ctx.tabId into the navigate payload (concurrency isolation)', async () => {
    const pinned = createMockCtx({ tabId: 42 });
    await onNavigate(pinned, { action: 'url', url: 'https://example.com' }, {});
    expect(pinned.ext.sendCmd).toHaveBeenCalledWith('navigate', expect.objectContaining({ tabId: 42 }));
  });

  it('forwards ctx.tabId into the reload payload', async () => {
    const pinned = createMockCtx({ tabId: 7 });
    await onNavigate(pinned, { action: 'reload' }, {});
    expect(pinned.ext.sendCmd).toHaveBeenCalledWith('navigate', { action: 'reload', tabId: 7 });
  });

  it('navigates back via history and reads the post-nav URL from getTabs (browser-process), not in-page eval', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      tabs: [{ id: 7, url: 'https://prev.com', attached: true }],
      attachedTabId: 7,
    });
    const result = await onNavigate(ctx, { action: 'back' }, {});
    expect(ctx.eval).toHaveBeenCalledWith('window.history.back()');
    // The URL read must NOT go through the (potentially pegged) renderer.
    expect(ctx.eval).not.toHaveBeenCalledWith('window.location.href');
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('getTabs', {});
    expect(ctx.sleep).toHaveBeenCalledWith(1500);
    expect(result.content[0].text).toContain('https://prev.com');
  });

  it('navigates forward via history and reads the post-nav URL from getTabs (browser-process), not in-page eval', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      tabs: [{ id: 9, url: 'https://next.com', attached: true }],
      attachedTabId: 9,
    });
    const result = await onNavigate(ctx, { action: 'forward' }, {});
    expect(ctx.eval).toHaveBeenCalledWith('window.history.forward()');
    expect(ctx.eval).not.toHaveBeenCalledWith('window.location.href');
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('getTabs', {});
    expect(ctx.sleep).toHaveBeenCalledWith(1500);
    expect(result.content[0].text).toContain('https://next.com');
  });

  it('back: URL is null when getTabs fails, without throwing (renderer-busy resilience)', async () => {
    (ctx.ext.sendCmd as any).mockRejectedValue(new Error('socket closed'));
    const result = await onNavigate(ctx, { action: 'back' }, {});
    expect(ctx.error).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('"url":null');
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

  it('returns error when post-navigate page is a chrome-error interstitial (neterror bodyClass)', async () => {
    (ctx.eval as any).mockResolvedValue(JSON.stringify({ bodyClass: 'neterror', href: 'https://blocked.example.com/' }));
    await onNavigate(ctx, { action: 'url', url: 'https://blocked.example.com/' }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('Chrome displayed an error interstitial'), expect.anything());
  });

  it('returns error when post-navigate location is chrome-error://', async () => {
    (ctx.eval as any).mockResolvedValue(JSON.stringify({ bodyClass: '', href: 'chrome-error://chromewebdata/' }));
    await onNavigate(ctx, { action: 'url', url: 'https://broken.example.com/' }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('Chrome displayed an error interstitial'), expect.anything());
  });

  it('does not flag a normal page as a chrome-error', async () => {
    (ctx.eval as any).mockResolvedValue(JSON.stringify({ bodyClass: 'page home', href: 'https://example.com/' }));
    await onNavigate(ctx, { action: 'url', url: 'https://example.com/' }, {});
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it('flags chrome-error after reload', async () => {
    (ctx.eval as any).mockResolvedValue(JSON.stringify({ bodyClass: 'neterror', href: 'https://gone.example.com/' }));
    await onNavigate(ctx, { action: 'reload' }, {});
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining('Chrome displayed an error interstitial'), expect.anything());
  });

  it('does not crash when chrome-error probe throws', async () => {
    (ctx.eval as any).mockRejectedValue(new Error('eval failed'));
    const result = await onNavigate(ctx, { action: 'url', url: 'https://example.com/' }, {});
    expect(ctx.error).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});
