import { describe, it, expect, vi } from 'vitest';
import { getCenterInFrame } from '../src/tools/lib/frames';

describe('getCenterInFrame — meta threading', () => {
  it('forwards {name, purpose} to ctx.getElementCenter on the top-frame happy path', async () => {
    const getElementCenter = vi.fn().mockResolvedValue({ x: 5, y: 6 });
    const ctx: any = { getElementCenter };
    await getCenterInFrame(ctx, '#fn', { name: 'first_name', purpose: 'enter name' });
    expect(getElementCenter).toHaveBeenCalledWith('#fn', { name: 'first_name', purpose: 'enter name' });
  });

  // The iframe-fallback path (meta threaded to captureFingerprintInContext) is covered
  // authoritatively in tools-frames.test.ts, which stubs the frame walk cleanly. It is not
  // re-asserted here because findElementInFrames can't be stubbed reliably in this file.
});

describe('click action passes action.name/purpose', () => {
  it('threads action.name and action.purpose into getCenterInFrame', async () => {
    // Import the registry to fetch the click handler after side-effect registration.
    await import('../src/tools/interaction/click');
    const framesMod: any = await import('../src/tools/lib/frames');
    const spy = vi.spyOn(framesMod, 'getCenterInFrame').mockResolvedValue({ x: 1, y: 2, contextId: null });

    const { executeAction } = await import('../src/tools/interaction/registry');
    const ctx: any = {
      getSelectorExpression: (s: string) => `q(${s})`,
      cdp: vi.fn().mockResolvedValue({}),
      sleep: () => Promise.resolve(),
      ext: { sendCmd: vi.fn().mockResolvedValue({}) },
    };
    // evalInFrameOrTop / moveCursorTo / detectSpawnedTabs are exercised with the stubbed cdp/ext.
    await executeAction(ctx, { type: 'click', selector: '#fn', name: 'First Name', purpose: 'submit' })
      .catch(() => { /* downstream probe reads may noop; we only assert the meta threading */ });

    expect(spy).toHaveBeenCalledWith(ctx, '#fn', { name: 'First Name', purpose: 'submit' });
  });
});

describe('type action passes action.name/purpose', () => {
  it('threads action.selector and action.name/purpose into resolveInFrames', async () => {
    // Import the registry to fetch the type handler after side-effect registration.
    await import('../src/tools/interaction/type');
    const framesMod: any = await import('../src/tools/lib/frames');
    const spy = vi.spyOn(framesMod, 'resolveInFrames').mockResolvedValue({ objectId: 'obj-1', contextId: null, frameId: null });

    const { executeAction } = await import('../src/tools/interaction/registry');
    const ctx: any = {
      getSelectorExpression: (s: string) => `q(${s})`,
      cdp: vi.fn().mockResolvedValue({}),
      eval: vi.fn().mockResolvedValue({ focused: true }),
      sleep: () => Promise.resolve(),
      ext: { sendCmd: vi.fn().mockResolvedValue({}) },
    };
    await executeAction(ctx, { type: 'type', selector: '#fn', text: 'hi', name: 'First Name', purpose: 'enter name' })
      .catch(() => { /* downstream probe reads may noop; we only assert the meta threading */ });

    expect(spy).toHaveBeenCalledWith(ctx, 'q(#fn)', '#fn', { name: 'First Name', purpose: 'enter name' });
  });
});
