import { describe, it, expect, vi } from 'vitest';
import { resolveInFrames } from '../src/tools/lib/frames';

describe('resolveInFrames — capture centralization', () => {
  it('fires capture with null contextId on the top-frame hit, passing raw selector + meta', async () => {
    const capture = vi.fn();
    const cdp = vi.fn().mockResolvedValue({ result: { objectId: 'obj-1' } }); // top-frame match
    const ctx: any = { cdp, captureFingerprintInContext: capture };
    const meta = { name: 'first_name', purpose: 'enter name' };
    const res = await resolveInFrames(ctx, 'document.querySelector("#fn")', '#fn', meta);
    expect(res).toMatchObject({ contextId: null });
    expect(capture).toHaveBeenCalledWith(null, '#fn', meta);
  });

  it('does not fire capture when no raw selector is supplied (back-compat)', async () => {
    const capture = vi.fn();
    const cdp = vi.fn().mockResolvedValue({ result: { objectId: 'obj-1' } });
    const ctx: any = { cdp, captureFingerprintInContext: capture };
    await resolveInFrames(ctx, 'document.querySelector("#fn")');
    expect(capture).not.toHaveBeenCalled();
  });

  it('does not throw when the hook is unwired', async () => {
    const cdp = vi.fn().mockResolvedValue({ result: { objectId: 'obj-1' } });
    const ctx: any = { cdp }; // no captureFingerprintInContext
    await expect(resolveInFrames(ctx, 'q', '#fn', {})).resolves.toBeTruthy();
  });
});
