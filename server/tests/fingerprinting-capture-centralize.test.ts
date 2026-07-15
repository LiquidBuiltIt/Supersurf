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

describe('file_upload — top-frame capture', () => {
  it('fires capture with null contextId on a top-frame hit, passing raw selector + meta', async () => {
    await import('../src/tools/interaction/file-upload');
    const { executeAction } = await import('../src/tools/interaction/registry');

    const capture = vi.fn();
    const cdp = vi.fn().mockImplementation((method: string) => {
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { objectId: 'o' } }); // top-frame selector hit
      if (method === 'DOM.describeNode') return Promise.resolve({ node: { backendNodeId: 42 } });
      if (method === 'DOM.setFileInputFiles') return Promise.resolve({});
      return Promise.resolve({});
    });
    const ctx: any = {
      cdp,
      eval: vi.fn().mockResolvedValue({ verified: true, count: 1 }), // verification read-back (top-frame path)
      captureFingerprintInContext: capture,
    };

    await executeAction(ctx, {
      type: 'file_upload', selector: '#file', files: ['/tmp/resume.pdf'],
      name: 'resume_upload', purpose: 'attach resume',
    });

    expect(capture).toHaveBeenCalledWith(null, '#file', { name: 'resume_upload', purpose: 'attach resume' });
  });
});
