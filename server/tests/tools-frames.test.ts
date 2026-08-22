import { describe, it, expect, vi } from 'vitest';
import { findElementInFrames, getCenterInFrame } from '../src/tools/lib/frames';
import type { ToolContext } from '../src/tools/lib/types';

function mockCtx(cdpImpl: (method: string, params: any) => Promise<any>): ToolContext {
  return {
    cdp: vi.fn(cdpImpl),
    eval: vi.fn(),
    ext: { sendCmd: vi.fn() } as any,
    connectionManager: null,
    sleep: vi.fn(),
    getElementCenter: vi.fn(),
    getSelectorExpression: vi.fn(),
    findAlternativeSelectors: vi.fn(),
    formatResult: vi.fn(),
    error: vi.fn(),
  };
}

describe('findElementInFrames', () => {
  it('returns null when frame tree has only the top frame', async () => {
    const ctx = mockCtx(async (method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [] } };
      throw new Error(`unexpected ${method}`);
    });
    const result = await findElementInFrames(ctx, 'document.querySelector("#x")');
    expect(result).toBeNull();
  });

  it('walks child frames in DFS order and returns first match with frameId', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top' },
            childFrames: [
              { frame: { id: 'child-a' }, childFrames: [] },
              { frame: { id: 'child-b' }, childFrames: [] },
            ],
          },
        };
      }
      if (method === 'Page.createIsolatedWorld') {
        return { executionContextId: params.frameId === 'child-a' ? 11 : 22 };
      }
      if (method === 'Runtime.evaluate') {
        if (params.contextId === 11) return { result: {} }; // no objectId
        if (params.contextId === 22) return { result: { objectId: 'obj-b' } };
      }
      throw new Error(`unexpected ${method}`);
    });
    const result = await findElementInFrames(ctx, 'document.querySelector("#x")');
    expect(result).toEqual({ objectId: 'obj-b', contextId: 22, frameId: 'child-b' });
  });

  it('uses isolated world name "supersurf_iframe"', async () => {
    const calls: any[] = [];
    const ctx = mockCtx(async (method, params) => {
      calls.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Runtime.evaluate') return { result: { objectId: 'obj' } };
    });
    await findElementInFrames(ctx, 'expr');
    const iso = calls.find(c => c.method === 'Page.createIsolatedWorld');
    expect(iso.params.worldName).toBe('supersurf_iframe');
  });
});

import { resolveInFrames, healSelectorAcrossFrames } from '../src/tools/lib/frames';

describe('resolveInFrames', () => {
  it('returns top-frame result with contextId=null and frameId=null when top-frame eval finds the element', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Runtime.evaluate' && params.contextId === undefined) {
        return { result: { objectId: 'top-obj' } };
      }
      throw new Error(`should not reach: ${method}`);
    });
    const result = await resolveInFrames(ctx, 'document.querySelector("#x")');
    expect(result).toEqual({
      objectId: 'top-obj', contextId: null, frameId: null,
      resolvedExpr: 'document.querySelector("#x")',
    });
  });

  it('falls through to findElementInFrames when top-frame has no match', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Runtime.evaluate' && params.contextId === undefined) {
        return { result: {} }; // no objectId
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
      if (method === 'Runtime.evaluate' && params.contextId === 42) {
        return { result: { objectId: 'child-obj' } };
      }
      throw new Error(`unexpected ${method}`);
    });
    const result = await resolveInFrames(ctx, 'expr');
    expect(result).toEqual({ objectId: 'child-obj', contextId: 42, frameId: 'c', resolvedExpr: 'expr' });
  });

  it('returns null when no frame contains the element', async () => {
    const ctx = mockCtx(async (method) => {
      if (method === 'Runtime.evaluate') return { result: {} };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [] } };
    });
    const result = await resolveInFrames(ctx, 'expr');
    expect(result).toBeNull();
  });

  it('fires captureFingerprintInContext(null, selector, meta) on a top-frame hit', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Runtime.evaluate' && params.contextId === undefined) {
        return { result: { objectId: 'top-obj' } };
      }
      throw new Error(`should not reach: ${method}`);
    });
    ctx.captureFingerprintInContext = vi.fn();
    const meta = { name: 'submit', purpose: 'submit form' };
    await resolveInFrames(ctx, 'document.querySelector("#x")', '#x', meta);
    expect(ctx.captureFingerprintInContext).toHaveBeenCalledWith(null, '#x', meta);
  });

  it('fires captureFingerprintInContext(contextId, selector, meta) on a child-frame hit', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Runtime.evaluate' && params.contextId === undefined) return { result: {} };
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
      if (method === 'Runtime.evaluate' && params.contextId === 42) return { result: { objectId: 'child-obj' } };
      throw new Error(`unexpected ${method}`);
    });
    ctx.captureFingerprintInContext = vi.fn();
    await resolveInFrames(ctx, 'expr', '#x');
    expect(ctx.captureFingerprintInContext).toHaveBeenCalledWith(42, '#x', undefined);
  });

  it('does not attempt a heal when ctx.healFingerprintInContext is not wired (experiment disabled)', async () => {
    const ctx = mockCtx(async (method) => {
      if (method === 'Runtime.evaluate') return { result: {} };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [] } };
    });
    // ctx.healFingerprintInContext left undefined (mockCtx default).
    const result = await resolveInFrames(ctx, 'expr', '#x');
    expect(result).toBeNull();
  });

  it('heals in the top frame when no frame matches the selector but the top-frame heal hook resolves', async () => {
    const ctx = mockCtx(async (method) => {
      if (method === 'Runtime.evaluate') return { result: {} };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [] } };
    });
    ctx.healFingerprintInContext = vi.fn().mockResolvedValue({
      cx: 10, cy: 10, score: 0.9, objectId: 'healed-obj', resolvedExpr: 'document.querySelector("#healed")',
    });
    const result = await resolveInFrames(ctx, 'expr', '#x');
    expect(result).toEqual({
      objectId: 'healed-obj', contextId: null, frameId: null,
      resolvedExpr: 'document.querySelector("#healed")',
    });
    expect(ctx.healFingerprintInContext).toHaveBeenCalledWith(null, '#x');
  });

  it('heals in a child frame, picking the highest-scoring resolvable hit', async () => {
    const ctxIds: Record<string, number> = { c1: 11, c2: 22 };
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Runtime.evaluate') return { result: {} };
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'top' },
            childFrames: [
              { frame: { id: 'c1' }, childFrames: [] },
              { frame: { id: 'c2' }, childFrames: [] },
            ],
          },
        };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: ctxIds[params.frameId] };
      throw new Error(`unexpected ${method}`);
    });
    ctx.healFingerprintInContext = vi.fn(async (contextId: number | null) => {
      if (contextId === null) return null; // top frame: no hit
      if (contextId === 11) return { cx: 1, cy: 1, score: 0.65, objectId: 'obj-c1', resolvedExpr: 'expr-c1' };
      if (contextId === 22) return { cx: 5, cy: 5, score: 0.95, objectId: 'obj-c2', resolvedExpr: 'expr-c2' };
      return null;
    });
    const result = await resolveInFrames(ctx, 'expr', '#x');
    expect(result).toEqual({ objectId: 'obj-c2', contextId: 22, frameId: 'c2', resolvedExpr: 'expr-c2' });
  });

  it('does not heal when the heal hook returns a hit with no objectId/resolvedExpr (coordinate-only, unresolvable)', async () => {
    const ctx = mockCtx(async (method) => {
      if (method === 'Runtime.evaluate') return { result: {} };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [] } };
    });
    ctx.healFingerprintInContext = vi.fn().mockResolvedValue({ cx: 10, cy: 10, score: 0.9 });
    const result = await resolveInFrames(ctx, 'expr', '#x');
    expect(result).toBeNull();
  });
});

describe('healSelectorAcrossFrames', () => {
  it('returns null when ctx.healFingerprintInContext is not wired', async () => {
    const ctx = mockCtx(async () => { throw new Error('cdp should not be called'); });
    const result = await healSelectorAcrossFrames(ctx, '#x');
    expect(result).toBeNull();
  });

  it('scores the top frame and every child frame, returning the highest-scoring resolvable hit', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      throw new Error(`unexpected ${method}`);
    });
    ctx.healFingerprintInContext = vi.fn(async (contextId: number | null) =>
      contextId === null
        ? { cx: 1, cy: 1, score: 0.6, objectId: 'top-heal', resolvedExpr: 'top-expr' }
        : { cx: 2, cy: 2, score: 0.9, objectId: 'child-heal', resolvedExpr: 'child-expr' });
    const result = await healSelectorAcrossFrames(ctx, '#x');
    expect(result).toEqual({ objectId: 'child-heal', contextId: 7, frameId: 'c', resolvedExpr: 'child-expr' });
  });
});

import { evalInFrameOrTop } from '../src/tools/lib/frames';

describe('evalInFrameOrTop', () => {
  it('uses ctx.eval (default context) when contextId is null', async () => {
    const ctx = mockCtx(async () => { throw new Error('cdp should not be called'); });
    ctx.eval = vi.fn().mockResolvedValue({ foo: 1 });
    const result = await evalInFrameOrTop(ctx, 'expr', null);
    expect(ctx.eval).toHaveBeenCalledWith('expr');
    expect(result).toEqual({ foo: 1 });
  });

  it('uses Runtime.evaluate with contextId when contextId is a number', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Runtime.evaluate' && params.contextId === 99) {
        return { result: { value: { bar: 2 } } };
      }
    });
    const result = await evalInFrameOrTop(ctx, 'expr', 99);
    expect(result).toEqual({ bar: 2 });
  });

  it('throws when Runtime.evaluate returns an exception', async () => {
    const ctx = mockCtx(async () => ({
      result: { value: undefined },
      exceptionDetails: { exception: { description: 'ReferenceError: foo is not defined' } },
    }));
    await expect(evalInFrameOrTop(ctx, 'expr', 5)).rejects.toThrow(/ReferenceError/);
  });
});

describe('getCenterInFrame', () => {
  it('uses ctx.getElementCenter for top-frame happy path', async () => {
    const ctx = mockCtx(async () => { throw new Error('cdp should not be called'); });
    ctx.getElementCenter = vi.fn().mockResolvedValue({ x: 100, y: 200 });
    const result = await getCenterInFrame(ctx, '#btn');
    expect(ctx.getElementCenter).toHaveBeenCalledWith('#btn', undefined);
    expect(result).toEqual({ x: 100, y: 200, contextId: null });
  });

  it('single-level iframe: adds iframe offset to element iframe-local rect', async () => {
    // Element rect inside iframe: left=10, top=20, width=40, height=30 → iframe-local center (30, 35)
    // Iframe <iframe> in top frame: left=100, top=50
    // Expected top-frame center: (100+30, 50+35) = (130, 85)
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate' && params.contextId === 7) {
        // returnByValue=true branch → element iframe-local rect
        if (params.returnByValue) return { result: { value: { left: 10, top: 20, width: 40, height: 30 } } };
        return { result: { objectId: 'el-obj' } };
      }
      if (method === 'DOM.getFrameOwner' && params.frameId === 'c') return { backendNodeId: 99 };
      if (method === 'DOM.resolveNode' && params.backendNodeId === 99 && params.executionContextId === undefined) {
        return { object: { objectId: 'iframe-obj' } };
      }
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'iframe-obj') {
        return { result: { value: { left: 100, top: 50 } } };
      }
    });
    ctx.getElementCenter = vi.fn().mockRejectedValue(new Error('Element not found: `#btn`'));
    ctx.getSelectorExpression = vi.fn((s) => `document.querySelector("${s}")`);
    const result = await getCenterInFrame(ctx, '#btn');
    expect(result).toEqual({ x: 130, y: 85, contextId: 7 });
  });

  it('nested iframe: accumulates offsets from both ancestors', async () => {
    // Element iframe-local in frame c2: left=5, top=5, w=10, h=10 → local center (10, 10)
    // c2's <iframe> in c1: left=50, top=50
    // c1's <iframe> in top: left=200, top=100
    // Expected: (200+50+10, 100+50+10) = (260, 160)
    const contexts: Record<string, number> = { c1: 11, c2: 22 };
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [
          { frame: { id: 'c1' }, childFrames: [
            { frame: { id: 'c2' }, childFrames: [] },
          ] },
        ] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: contexts[params.frameId] };
      if (method === 'Runtime.evaluate') {
        if (params.contextId === 22) {
          if (params.returnByValue) return { result: { value: { left: 5, top: 5, width: 10, height: 10 } } };
          return { result: { objectId: 'el-obj' } };
        }
        if (params.contextId === 11) return { result: {} }; // no match in c1
      }
      if (method === 'DOM.getFrameOwner' && params.frameId === 'c2') return { backendNodeId: 222 };
      if (method === 'DOM.getFrameOwner' && params.frameId === 'c1') return { backendNodeId: 111 };
      // Owner of c2 resolves in c1's context (11)
      if (method === 'DOM.resolveNode' && params.backendNodeId === 222 && params.executionContextId === 11) {
        return { object: { objectId: 'c2-iframe' } };
      }
      // Owner of c1 resolves in top-frame default context
      if (method === 'DOM.resolveNode' && params.backendNodeId === 111 && params.executionContextId === undefined) {
        return { object: { objectId: 'c1-iframe' } };
      }
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'c2-iframe') {
        return { result: { value: { left: 50, top: 50 } } };
      }
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'c1-iframe') {
        return { result: { value: { left: 200, top: 100 } } };
      }
    });
    ctx.getElementCenter = vi.fn().mockRejectedValue(new Error('Element not found'));
    ctx.getSelectorExpression = vi.fn((s) => `document.querySelector("${s}")`);
    const result = await getCenterInFrame(ctx, '#deep');
    expect(result).toEqual({ x: 260, y: 160, contextId: 22 });
  });

  it('iframe-fallback: fires captureFingerprintInContext with the resolved contextId', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate' && params.contextId === 7) {
        if (params.returnByValue) return { result: { value: { left: 10, top: 20, width: 40, height: 30 } } };
        return { result: { objectId: 'el-obj' } };
      }
      if (method === 'DOM.getFrameOwner' && params.frameId === 'c') return { backendNodeId: 99 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'iframe-obj' } };
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'iframe-obj') {
        return { result: { value: { left: 100, top: 50 } } };
      }
    });
    ctx.getElementCenter = vi.fn().mockRejectedValue(new Error('Element not found: `#btn`'));
    ctx.getSelectorExpression = vi.fn((s) => `document.querySelector("${s}")`);
    ctx.captureFingerprintInContext = vi.fn();
    const result = await getCenterInFrame(ctx, '#btn');
    expect(result).toEqual({ x: 130, y: 85, contextId: 7 });
    expect(ctx.captureFingerprintInContext).toHaveBeenCalledWith(7, '#btn', undefined);
  });

  it('iframe-fallback: translates a handle before firing captureFingerprintInContext (not the raw handle)', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate' && params.contextId === 7) {
        if (params.returnByValue) return { result: { value: { left: 10, top: 20, width: 40, height: 30 } } };
        return { result: { objectId: 'el-obj' } };
      }
      if (method === 'DOM.getFrameOwner' && params.frameId === 'c') return { backendNodeId: 99 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'iframe-obj' } };
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'iframe-obj') {
        return { result: { value: { left: 100, top: 50 } } };
      }
    });
    ctx.getElementCenter = vi.fn().mockRejectedValue(new Error('Element not found: `tweet_button`'));
    ctx.getSelectorExpression = vi.fn((s) => `document.querySelector("${s}")`);
    ctx.resolveSelector = vi.fn((s: string) => (s === 'tweet_button' ? '#post' : s));
    ctx.captureFingerprintInContext = vi.fn();
    const result = await getCenterInFrame(ctx, 'tweet_button');
    expect(result).toEqual({ x: 130, y: 85, contextId: 7 });
    // Bug would pass the raw handle here — the capture key must be the translated selector,
    // since the fingerprint store's keys are real CSS selectors, not handle names.
    expect(ctx.captureFingerprintInContext).toHaveBeenCalledWith(7, '#post', undefined);
    expect(ctx.captureFingerprintInContext).not.toHaveBeenCalledWith(7, 'tweet_button', undefined);
  });

  it('top-frame happy path does NOT fire captureFingerprintInContext (capture handled in getElementCenter)', async () => {
    const ctx = mockCtx(async () => { throw new Error('cdp should not be called'); });
    ctx.getElementCenter = vi.fn().mockResolvedValue({ x: 100, y: 200 });
    ctx.captureFingerprintInContext = vi.fn();
    await getCenterInFrame(ctx, '#btn');
    expect(ctx.captureFingerprintInContext).not.toHaveBeenCalled();
  });

  it('iframe heal: scores a stored fingerprint across child frames and returns top-frame-translated coords on a gate-passing hit', async () => {
    // Selector matches no frame; the heal hook returns a gate-passing hit in frame c (ctx 7).
    // Hit iframe-local center (30, 35); iframe offset (100, 50) → top-frame (130, 85).
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      // findElementInFrames probe: selector matches nothing in any frame.
      if (method === 'Runtime.evaluate' && !params.returnByValue) return { result: {} };
      if (method === 'DOM.getFrameOwner' && params.frameId === 'c') return { backendNodeId: 99 };
      if (method === 'DOM.resolveNode' && params.backendNodeId === 99) return { object: { objectId: 'iframe-obj' } };
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'iframe-obj') {
        return { result: { value: { left: 100, top: 50 } } };
      }
    });
    ctx.getElementCenter = vi.fn().mockRejectedValue(new Error('Element not found: `#btn`'));
    ctx.getSelectorExpression = vi.fn((s) => `document.querySelector("${s}")`);
    ctx.healFingerprintInContext = vi.fn().mockResolvedValue({ cx: 30, cy: 35, score: 0.9 });
    const result = await getCenterInFrame(ctx, '#btn');
    expect(result).toEqual({ x: 130, y: 85, contextId: 7 });
    expect(ctx.healFingerprintInContext).toHaveBeenCalledWith(7, '#btn');
  });

  it('iframe heal: picks the highest-scoring frame when more than one yields a gate-passing hit', async () => {
    // Two child frames; the hook returns a low-score hit in c1 and a high-score hit in c2.
    const ctxIds: Record<string, number> = { c1: 11, c2: 22 };
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [
          { frame: { id: 'c1' }, childFrames: [] },
          { frame: { id: 'c2' }, childFrames: [] },
        ] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: ctxIds[params.frameId] };
      if (method === 'Runtime.evaluate' && !params.returnByValue) return { result: {} };
      if (method === 'DOM.getFrameOwner' && params.frameId === 'c2') return { backendNodeId: 222 };
      if (method === 'DOM.resolveNode' && params.backendNodeId === 222) return { object: { objectId: 'c2-iframe' } };
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'c2-iframe') {
        return { result: { value: { left: 200, top: 100 } } };
      }
    });
    ctx.getElementCenter = vi.fn().mockRejectedValue(new Error('Element not found'));
    ctx.getSelectorExpression = vi.fn((s) => `document.querySelector("${s}")`);
    ctx.healFingerprintInContext = vi.fn(async (contextId: number) =>
      contextId === 11 ? { cx: 1, cy: 1, score: 0.65 } : { cx: 5, cy: 5, score: 0.95 });
    const result = await getCenterInFrame(ctx, '#btn');
    // Winner is c2 (score 0.95): local (5,5) + offset (200,100) = (205, 105), contextId 22.
    expect(result).toEqual({ x: 205, y: 105, contextId: 22 });
  });

  it('iframe heal: translates a handle before calling healFingerprintInContext (not the raw handle)', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      // findElementInFrames probe: selector matches nothing in any frame.
      if (method === 'Runtime.evaluate' && !params.returnByValue) return { result: {} };
      if (method === 'DOM.getFrameOwner' && params.frameId === 'c') return { backendNodeId: 99 };
      if (method === 'DOM.resolveNode' && params.backendNodeId === 99) return { object: { objectId: 'iframe-obj' } };
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'iframe-obj') {
        return { result: { value: { left: 100, top: 50 } } };
      }
    });
    ctx.getElementCenter = vi.fn().mockRejectedValue(new Error('Element not found: `tweet_button`'));
    ctx.getSelectorExpression = vi.fn((s) => `document.querySelector("${s}")`);
    ctx.resolveSelector = vi.fn((s: string) => (s === 'tweet_button' ? '#post' : s));
    ctx.healFingerprintInContext = vi.fn().mockResolvedValue({ cx: 30, cy: 35, score: 0.9 });
    const result = await getCenterInFrame(ctx, 'tweet_button');
    expect(result).toEqual({ x: 130, y: 85, contextId: 7 });
    // Bug would pass the raw handle here — store keys are real CSS selectors, so a
    // handle-keyed heal lookup can never hit.
    expect(ctx.healFingerprintInContext).toHaveBeenCalledWith(7, '#post');
    expect(ctx.healFingerprintInContext).not.toHaveBeenCalledWith(7, 'tweet_button');
  });

  it('iframe heal: throws the original top-frame error when no frame yields a gate-passing hit', async () => {
    const ctx = mockCtx(async (method) => {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') return { result: {} };
    });
    const topErr = new Error('Element not found: `#btn`');
    ctx.getElementCenter = vi.fn().mockRejectedValue(topErr);
    ctx.getSelectorExpression = vi.fn((s) => `document.querySelector("${s}")`);
    ctx.healFingerprintInContext = vi.fn().mockResolvedValue(null);
    await expect(getCenterInFrame(ctx, '#btn')).rejects.toBe(topErr);
  });

  it('re-throws the original top-frame error when no frame contains the element', async () => {
    const ctx = mockCtx(async (method) => {
      if (method === 'Runtime.evaluate') return { result: {} };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [] } };
    });
    const topErr = new Error('Element not found: `#btn`\n\nDid you mean?\n  1. `#submit`');
    ctx.getElementCenter = vi.fn().mockRejectedValue(topErr);
    ctx.getSelectorExpression = vi.fn((s) => `document.querySelector("${s}")`);
    await expect(getCenterInFrame(ctx, '#btn')).rejects.toBe(topErr);
  });
});
