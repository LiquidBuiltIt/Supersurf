# Iframe Support for browser_interact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `findElementInFrames` auto-fallback (currently only used by `file_upload`) to every selector-based `browser_interact` action so agents stop burning `browser_evaluate` calls on manual iframe traversal.

**Architecture:** Add a `server/src/tools/frames.ts` module with four shared primitives (`findElementInFrames`, `resolveInFrames`, `evalInFrameOrTop`, `getCenterInFrame`). Each affected action in `interaction.ts` gains a two-step pattern identical to the current `file_upload` — try top frame first, then DFS child frames on miss. No schema changes. No extension changes. No new MCP tools.

**Tech Stack:** TypeScript, Vitest, CDP (`Page.getFrameTree`, `Page.createIsolatedWorld`, `Runtime.evaluate`, `DOM.describeNode`, `DOM.getBoxModel`, `DOM.pushNodeByBackendIdToFrontend`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `CSS.forcePseudoState`).

---

## File Structure

- **Create:** `server/src/tools/frames.ts` — shared frame-aware primitives
- **Create:** `server/tests/tools-frames.test.ts` — unit tests for helpers
- **Create:** `docs/research/2026-04-19-dom-getboxmodel-iframe-coords.md` — research artifact for Phase 0
- **Modify:** `server/src/tools/interaction.ts` — `findElementInFrames` moves out; each selector action uses new helpers
- **Modify:** `server/tests/tools-interaction.test.ts` — iframe fallback tests per action
- **Modify:** `CLAUDE.md` — note iframe auto-fallback in Architecture → Server section

No schema change. No extension change. No new top-level files beyond the helpers module + its test + research artifact.

---

## Phase 0: Research

### Task 1: Verify `DOM.getBoxModel` returns main-frame viewport coordinates for elements inside iframes

**Research only — no production code. Output is a markdown artifact that Task 5 (`getCenterInFrame`) depends on.**

**Files:**
- Create: `docs/research/2026-04-19-dom-getboxmodel-iframe-coords.md`

- [ ] **Step 1: Read the CDP spec for `DOM.getBoxModel`**

Fetch `https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-getBoxModel`. Note what the spec says about coordinate space for nodes inside child frames. Copy the relevant sentence verbatim into the artifact.

- [ ] **Step 2: Confirm by reading Playwright's implementation**

Playwright clicks via CDP and supports iframes natively. Find the source file that computes click coordinates for cross-frame elements (search `playwright-core` for `getBoxModel` or `getContentQuads`). Confirm it does NOT apply manual frame-offset addition — if Playwright trusts CDP to return main-frame coords, so can we. Paste the relevant 5–10 lines into the artifact with a permalink.

- [ ] **Step 3: Write the artifact**

Structure:
```markdown
# DOM.getBoxModel coordinates for iframe children — verification

## Question
When `DOM.getBoxModel` is called with a `backendNodeId` for an element inside a same-origin or cross-origin iframe, are the returned content-quad coordinates relative to the main frame's viewport, or the iframe's local viewport?

## Answer
[one sentence]

## Evidence
- CDP spec excerpt: [...]
- Playwright reference: [file:line + permalink + code snippet]

## Implication for this plan
[one paragraph — what Task 5 should do based on the answer]
```

- [ ] **Step 4: Commit**

```bash
git add docs/research/2026-04-19-dom-getboxmodel-iframe-coords.md
git commit -m "research: verify DOM.getBoxModel returns main-frame coords for iframe children"
```

---

## Phase 1: Shared frame-aware primitives

### Task 2: Move `findElementInFrames` to `server/src/tools/frames.ts` and generalize

**Files:**
- Create: `server/src/tools/frames.ts`
- Create: `server/tests/tools-frames.test.ts`
- Modify: `server/src/tools/interaction.ts` (remove the local helper, import from `./frames`)

- [ ] **Step 1: Write the failing test**

Create `server/tests/tools-frames.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { findElementInFrames } from '../src/tools/frames';
import type { ToolContext } from '../src/tools/types';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-frames.test.ts`
Expected: FAIL with "Cannot find module '../src/tools/frames'"

- [ ] **Step 3: Create `server/src/tools/frames.ts` with `findElementInFrames`**

```typescript
import type { ToolContext } from './types';

/**
 * DFS-walk the frame tree and evaluate `selectorExpr` in each child frame's
 * isolated world. Returns the first frame where the expression yields a
 * non-null `objectId`, along with that frame's execution context id so the
 * caller can re-use it for post-action read-backs.
 *
 * Isolated worlds sidestep CSP restrictions and page-installed Proxy
 * shenanigans, mirroring the extension's content-script isolation.
 */
export async function findElementInFrames(
  ctx: ToolContext,
  selectorExpr: string
): Promise<{ objectId: string; contextId: number; frameId: string } | null> {
  let tree: any;
  try {
    tree = await ctx.cdp('Page.getFrameTree', {});
  } catch {
    return null;
  }
  const root = tree?.frameTree;
  if (!root) return null;

  const frameIds: string[] = [];
  const walk = (node: any, isRoot: boolean) => {
    if (!node?.frame?.id) return;
    if (!isRoot) frameIds.push(node.frame.id);
    const children = node.childFrames || [];
    for (const child of children) walk(child, false);
  };
  walk(root, true);

  for (const frameId of frameIds) {
    let contextId: number;
    try {
      const world = await ctx.cdp('Page.createIsolatedWorld', {
        frameId,
        worldName: 'supersurf_iframe',
        grantUniveralAccess: false,
      });
      contextId = world.executionContextId;
    } catch {
      continue;
    }
    if (contextId == null) continue;

    try {
      const result = await ctx.cdp('Runtime.evaluate', {
        expression: selectorExpr,
        contextId,
        returnByValue: false,
      });
      const objectId = result?.result?.objectId;
      if (objectId) return { objectId, contextId, frameId };
    } catch {
      continue;
    }
  }
  return null;
}
```

- [ ] **Step 4: Remove the local `findElementInFrames` from `interaction.ts` and import it**

In `server/src/tools/interaction.ts`:
- Delete lines 184–251 (the local `findElementInFrames` function + its JSDoc).
- Add to the import block at the top: `import { findElementInFrames } from './frames';`
- Update the `file_upload` case call site (currently around line 698) — no change needed, the imported function has the same signature.

- [ ] **Step 5: Run both test files to verify pass**

Run: `cd server && npx vitest run tests/tools-frames.test.ts tests/tools-interaction.test.ts`
Expected: ALL PASS (tools-frames: 3 new tests; tools-interaction: existing tests unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/src/tools/frames.ts server/src/tools/interaction.ts server/tests/tools-frames.test.ts
git commit -m "refactor: extract findElementInFrames to shared frames module"
```

---

### Task 3: Add `resolveInFrames` — top-frame-first element resolution with DFS fallback

**Files:**
- Modify: `server/src/tools/frames.ts`
- Modify: `server/tests/tools-frames.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-frames.test.ts`:

```typescript
import { resolveInFrames } from '../src/tools/frames';

describe('resolveInFrames', () => {
  it('returns top-frame result with contextId=null and frameId=null when top-frame eval finds the element', async () => {
    const ctx = mockCtx(async (method, params) => {
      if (method === 'Runtime.evaluate' && params.contextId === undefined) {
        return { result: { objectId: 'top-obj' } };
      }
      throw new Error(`should not reach: ${method}`);
    });
    const result = await resolveInFrames(ctx, 'document.querySelector("#x")');
    expect(result).toEqual({ objectId: 'top-obj', contextId: null, frameId: null });
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
    expect(result).toEqual({ objectId: 'child-obj', contextId: 42, frameId: 'c' });
  });

  it('returns null when no frame contains the element', async () => {
    const ctx = mockCtx(async (method) => {
      if (method === 'Runtime.evaluate') return { result: {} };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [] } };
    });
    const result = await resolveInFrames(ctx, 'expr');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-frames.test.ts`
Expected: FAIL with "resolveInFrames is not a function" or import error.

- [ ] **Step 3: Add `resolveInFrames` to `frames.ts`**

Append to `server/src/tools/frames.ts`:

```typescript
/**
 * Resolve an element: try top frame first, then DFS child frames on miss.
 * `contextId` and `frameId` are both `null` when the element was found in
 * the top frame, otherwise they identify the child frame that owns it.
 */
export async function resolveInFrames(
  ctx: ToolContext,
  selectorExpr: string
): Promise<{ objectId: string; contextId: number | null; frameId: string | null } | null> {
  const top = await ctx.cdp('Runtime.evaluate', {
    expression: selectorExpr,
    returnByValue: false,
  });
  const topObjectId = top?.result?.objectId;
  if (topObjectId) return { objectId: topObjectId, contextId: null, frameId: null };

  const match = await findElementInFrames(ctx, selectorExpr);
  if (!match) return null;
  return match;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-frames.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/frames.ts server/tests/tools-frames.test.ts
git commit -m "feat: add resolveInFrames helper with top-frame-first fallback"
```

---

### Task 4: Add `evalInFrameOrTop` — context-aware evaluation

**Files:**
- Modify: `server/src/tools/frames.ts`
- Modify: `server/tests/tools-frames.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-frames.test.ts`:

```typescript
import { evalInFrameOrTop } from '../src/tools/frames';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-frames.test.ts`
Expected: FAIL with import error.

- [ ] **Step 3: Add `evalInFrameOrTop` to `frames.ts`**

Append to `server/src/tools/frames.ts`:

```typescript
/**
 * Evaluate an expression in the given frame context, or top-frame default
 * context if `contextId` is null. Mirrors the error semantics of `ctx.eval`.
 */
export async function evalInFrameOrTop(
  ctx: ToolContext,
  expression: string,
  contextId: number | null
): Promise<any> {
  if (contextId === null) return ctx.eval(expression);

  const result = await ctx.cdp('Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    const msg = d.exception?.description || d.text || d.exception?.className || 'JavaScript execution error';
    throw new Error(msg);
  }
  return result.result?.value;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-frames.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/frames.ts server/tests/tools-frames.test.ts
git commit -m "feat: add evalInFrameOrTop helper"
```

---

### Task 5: Add `getCenterInFrame` — frame-aware viewport coordinate resolution

**Files:**
- Modify: `server/src/tools/frames.ts`
- Modify: `server/tests/tools-frames.test.ts`

**Depends on:** Task 1 (research artifact — `DOM.getBoxModel` returns **iframe-local** coords for iframe children; we must walk up the frame chain and add each ancestor iframe's `getBoundingClientRect()` top-left to compute top-frame viewport coords).

**Algorithm:**
1. Top-frame happy path: `ctx.getElementCenter(selector)` — preserves "Did you mean?" hints.
2. On miss, `findElementInFrames` returns `{ objectId, contextId, frameId }`.
3. In the frame's isolated world, read the element's `getBoundingClientRect()` (iframe-local coords).
4. Walk up via `Page.getFrameTree` parent map. For each ancestor iframe (from target's frame toward root):
   - `DOM.getFrameOwner({ frameId })` → the `<iframe>` element's `backendNodeId` in its parent document.
   - Get the parent's execution context (default context for root; create isolated world for intermediate ancestors, cached).
   - `DOM.resolveNode({ backendNodeId, executionContextId })` → objectId.
   - `Runtime.callFunctionOn` with `function() { const r = this.getBoundingClientRect(); return { left: r.left, top: r.top }; }` → iframe's rect in the parent frame.
   - Accumulate offset.
5. Top-frame viewport coords = element rect + accumulated offset. Center = top-left + (w/2, h/2).

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-frames.test.ts`:

```typescript
import { getCenterInFrame } from '../src/tools/frames';

describe('getCenterInFrame', () => {
  it('uses ctx.getElementCenter for top-frame happy path', async () => {
    const ctx = mockCtx(async () => { throw new Error('cdp should not be called'); });
    ctx.getElementCenter = vi.fn().mockResolvedValue({ x: 100, y: 200 });
    const result = await getCenterInFrame(ctx, '#btn');
    expect(ctx.getElementCenter).toHaveBeenCalledWith('#btn');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-frames.test.ts`
Expected: FAIL with import error.

- [ ] **Step 3: Add `getCenterInFrame` to `frames.ts`**

Append to `server/src/tools/frames.ts`:

```typescript
/**
 * Resolve top-frame viewport coordinates for an element, whether it lives in
 * the top frame or a child frame. Preserves `ctx.getElementCenter`'s
 * "Did you mean?" hints on top-frame happy path; only falls back to iframe
 * resolution when the top-frame lookup actually fails.
 *
 * `DOM.getBoxModel` and `getBoundingClientRect` return **iframe-local**
 * coordinates for nodes inside iframes (verified in
 * docs/research/2026-04-19-dom-getboxmodel-iframe-coords.md). This function
 * walks up the frame tree and accumulates each ancestor iframe's top-left
 * offset to produce top-frame viewport coordinates — same approach Playwright
 * and Puppeteer use.
 */
export async function getCenterInFrame(
  ctx: ToolContext,
  selector: string
): Promise<{ x: number; y: number; contextId: number | null }> {
  try {
    const { x, y } = await ctx.getElementCenter(selector);
    return { x, y, contextId: null };
  } catch (topFrameErr) {
    const expr = ctx.getSelectorExpression(selector);
    const match = await findElementInFrames(ctx, expr);
    if (!match) throw topFrameErr;

    // Read the element's iframe-local rect in its frame context.
    const rectEval = await ctx.cdp('Runtime.evaluate', {
      expression: `
        (() => {
          const el = ${expr};
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        })()
      `,
      contextId: match.contextId,
      returnByValue: true,
    });
    const rect = rectEval.result?.value;
    if (!rect) throw topFrameErr;

    // Build parent map from the frame tree.
    const tree = await ctx.cdp('Page.getFrameTree', {});
    const parentMap = new Map<string, string>();
    const walkTree = (node: any, parentId: string | null) => {
      const fid = node?.frame?.id;
      if (!fid) return;
      if (parentId) parentMap.set(fid, parentId);
      for (const child of node.childFrames || []) walkTree(child, fid);
    };
    walkTree(tree.frameTree, null);

    // Walk up from target frame, accumulating iframe offsets.
    const contextCache = new Map<string, number>();
    contextCache.set(match.frameId, match.contextId);
    let offsetX = 0, offsetY = 0;
    let current = match.frameId;
    while (parentMap.has(current)) {
      const parent = parentMap.get(current)!;
      // Parent's execution context: undefined (default/top-frame) if parent is root,
      // otherwise an isolated world (create and cache).
      let parentCtxId: number | undefined;
      if (parentMap.has(parent)) {
        if (!contextCache.has(parent)) {
          const w = await ctx.cdp('Page.createIsolatedWorld', {
            frameId: parent,
            worldName: 'supersurf_iframe',
            grantUniveralAccess: false,
          });
          contextCache.set(parent, w.executionContextId);
        }
        parentCtxId = contextCache.get(parent)!;
      } else {
        parentCtxId = undefined; // top-frame default context
      }

      const owner = await ctx.cdp('DOM.getFrameOwner', { frameId: current });
      const resolved = await ctx.cdp('DOM.resolveNode', {
        backendNodeId: owner.backendNodeId,
        executionContextId: parentCtxId,
      });
      const iframeObjId = resolved.object?.objectId;
      if (!iframeObjId) throw topFrameErr;

      const iframeRect = await ctx.cdp('Runtime.callFunctionOn', {
        objectId: iframeObjId,
        functionDeclaration: 'function() { const r = this.getBoundingClientRect(); return { left: r.left, top: r.top }; }',
        returnByValue: true,
      });
      const or = iframeRect.result?.value;
      if (!or) throw topFrameErr;
      offsetX += or.left;
      offsetY += or.top;
      current = parent;
    }

    const x = Math.round(rect.left + offsetX + rect.width / 2);
    const y = Math.round(rect.top + offsetY + rect.height / 2);
    return { x, y, contextId: match.contextId };
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-frames.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Report changes**

Report the list of files modified and test output to the controlling session. Do not commit — the user handles all git operations.

---

## Phase 2: Wire each action to frame-aware helpers

Pattern for every action below: preserve the top-frame happy path as-is; only engage the frame helper on miss.

### Task 6: Wire `wait` action to frame-aware polling

The `wait` action polls `document.querySelector(selector)` until found or timeout. Polling needs to check both top frame AND child frames each tick.

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `wait` case)
- Modify: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-interaction.test.ts`:

```typescript
it('wait falls back to child frames when top-frame selector misses', async () => {
  // Top-frame query returns null; child-frame query returns an objectId.
  let topCall = 0;
  (ctx.cdp as any).mockImplementation(async (method: string, params: any) => {
    if (method === 'Runtime.evaluate' && params.contextId === undefined) {
      topCall++;
      return { result: {} }; // no objectId in top frame
    }
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 3 };
    if (method === 'Runtime.evaluate' && params.contextId === 3) {
      return { result: { objectId: 'found' } };
    }
  });
  const result = await onInteract(ctx, {
    actions: [{ type: 'wait', selector: '#late', timeout: 1000 }],
  }, {});
  expect(result.content[0].text).toContain('#late');
  expect(result.isError).toBeFalsy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts -t "wait falls back"`
Expected: FAIL — test times out or reports "Element not found" because current code only checks top frame.

- [ ] **Step 3: Modify the `wait` case in `interaction.ts`**

Find the current `wait` case (around line 381–403). Replace its polling eval with a call to `resolveInFrames` inside the poll loop:

```typescript
case 'wait': {
  if (!action.selector) {
    if (action.timeout) { await ctx.sleep(action.timeout); return `Waited ${action.timeout}ms`; }
    throw new Error('wait requires either selector or timeout');
  }
  const timeoutMs = action.timeout ?? 5000;
  const selectorExpr = ctx.getSelectorExpression(action.selector);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = await resolveInFrames(ctx, selectorExpr);
    if (match) return `Found ${action.selector}`;
    await ctx.sleep(100);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${action.selector}`);
}
```

Add to imports at top of file: `import { resolveInFrames } from './frames';` (if not already added by Task 2).

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts`
Expected: ALL PASS, including the new iframe-fallback test.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: wait action auto-falls-back to child frames"
```

---

### Task 7: Wire `clear` action to frame-aware evaluation

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `clear` case)
- Modify: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-interaction.test.ts`:

```typescript
it('clear falls back to child frames when top-frame selector misses', async () => {
  (ctx.eval as any).mockImplementation(async (expr: string) => {
    // Top-frame eval reports the element was not found.
    return { cleared: false, reason: 'not-found' };
  });
  (ctx.cdp as any).mockImplementation(async (method: string, params: any) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 4 };
    if (method === 'Runtime.evaluate' && params.contextId === 4) {
      // First call: resolve the element. Second call: perform the clear eval.
      if (params.expression.includes('getBoundingClientRect')) return { result: {} }; // irrelevant
      if (params.returnByValue) return { result: { value: { cleared: true } } };
      return { result: { objectId: 'obj-in-frame' } };
    }
  });
  const result = await onInteract(ctx, {
    actions: [{ type: 'clear', selector: '#input' }],
  }, {});
  expect(result.content[0].text).toContain('Cleared');
  expect(result.isError).toBeFalsy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts -t "clear falls back"`
Expected: FAIL.

- [ ] **Step 3: Modify the `clear` case in `interaction.ts`**

Replace the current `clear` case (around line 344–356) with:

```typescript
case 'clear': {
  const selectorExpr = ctx.getSelectorExpression(action.selector);
  const match = await resolveInFrames(ctx, selectorExpr);
  if (!match) throw new Error(`Element not found: ${action.selector}`);
  const clearExpr = `
    (() => {
      const el = ${selectorExpr};
      if (!el) return { cleared: false };
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { cleared: true };
    })()
  `;
  const result = await evalInFrameOrTop(ctx, clearExpr, match.contextId);
  if (!result?.cleared) throw new Error(`Failed to clear ${action.selector}`);
  return `Cleared ${action.selector}`;
}
```

Add to imports: `import { resolveInFrames, evalInFrameOrTop } from './frames';`

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: clear action auto-falls-back to child frames"
```

---

### Task 8: Wire `scroll_to` and `scroll_by` to frame-aware evaluation

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `scroll_to` / `scroll_by` cases)
- Modify: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-interaction.test.ts`:

```typescript
it('scroll_to with selector falls back to child frames', async () => {
  (ctx.eval as any).mockResolvedValue(null); // top-frame miss
  (ctx.cdp as any).mockImplementation(async (method: string, params: any) => {
    if (method === 'Runtime.evaluate' && params.contextId === undefined) return { result: {} };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
    if (method === 'Runtime.evaluate' && params.contextId === 5) {
      if (params.returnByValue) return { result: { value: { scrolled: true } } };
      return { result: { objectId: 'obj' } };
    }
  });
  const result = await onInteract(ctx, {
    actions: [{ type: 'scroll_to', selector: '#target', x: 0, y: 100 }],
  }, {});
  expect(result.content[0].text).toContain('Scrolled');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts -t "scroll_to with selector falls back"`
Expected: FAIL.

- [ ] **Step 3: Modify `scroll_to` and `scroll_by` cases in `interaction.ts`**

For the `scroll_to` case (around line 443): if a `selector` is given, rewrite to use `resolveInFrames` + `evalInFrameOrTop`. Leave the `window.scrollTo` path (no selector) unchanged.

```typescript
case 'scroll_to': {
  if (action.selector) {
    const selectorExpr = ctx.getSelectorExpression(action.selector);
    const match = await resolveInFrames(ctx, selectorExpr);
    if (!match) throw new Error(`Element not found: ${action.selector}`);
    const expr = `
      (() => {
        const el = ${selectorExpr};
        if (!el) return { scrolled: false };
        el.scrollTo(${action.x ?? 0}, ${action.y ?? 0});
        return { scrolled: true };
      })()
    `;
    const r = await evalInFrameOrTop(ctx, expr, match.contextId);
    if (!r?.scrolled) throw new Error(`Failed to scroll ${action.selector}`);
    return `Scrolled ${action.selector} to (${action.x ?? 0}, ${action.y ?? 0})`;
  }
  await ctx.eval(`window.scrollTo(${action.x ?? 0}, ${action.y ?? 0})`);
  return `Scrolled window to (${action.x ?? 0}, ${action.y ?? 0})`;
}

case 'scroll_by': {
  if (action.selector) {
    const selectorExpr = ctx.getSelectorExpression(action.selector);
    const match = await resolveInFrames(ctx, selectorExpr);
    if (!match) throw new Error(`Element not found: ${action.selector}`);
    const expr = `
      (() => {
        const el = ${selectorExpr};
        if (!el) return { scrolled: false };
        el.scrollBy(${action.x ?? 0}, ${action.y ?? 0});
        return { scrolled: true };
      })()
    `;
    const r = await evalInFrameOrTop(ctx, expr, match.contextId);
    if (!r?.scrolled) throw new Error(`Failed to scroll ${action.selector}`);
    return `Scrolled ${action.selector} by (${action.x ?? 0}, ${action.y ?? 0})`;
  }
  await ctx.eval(`window.scrollBy(${action.x ?? 0}, ${action.y ?? 0})`);
  return `Scrolled window by (${action.x ?? 0}, ${action.y ?? 0})`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: scroll_to/scroll_by auto-fall-back to child frames"
```

---

### Task 9: Wire `scroll_into_view` to frame-aware evaluation

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `scroll_into_view` case)
- Modify: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-interaction.test.ts`:

```typescript
it('scroll_into_view falls back to child frames', async () => {
  (ctx.eval as any).mockResolvedValue(null);
  (ctx.cdp as any).mockImplementation(async (method: string, params: any) => {
    if (method === 'Runtime.evaluate' && params.contextId === undefined) return { result: {} };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 6 };
    if (method === 'Runtime.evaluate' && params.contextId === 6) {
      if (params.returnByValue) return { result: { value: { scrolled: true } } };
      return { result: { objectId: 'obj' } };
    }
  });
  const result = await onInteract(ctx, {
    actions: [{ type: 'scroll_into_view', selector: '#target' }],
  }, {});
  expect(result.content[0].text).toContain('into view');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts -t "scroll_into_view falls back"`
Expected: FAIL.

- [ ] **Step 3: Modify `scroll_into_view` case**

Replace the current case (around line 463–473) with:

```typescript
case 'scroll_into_view': {
  const selectorExpr = ctx.getSelectorExpression(action.selector);
  const match = await resolveInFrames(ctx, selectorExpr);
  if (!match) throw new Error(`Element not found: ${action.selector}`);
  const expr = `
    (() => {
      const el = ${selectorExpr};
      if (!el) return { scrolled: false };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { scrolled: true };
    })()
  `;
  const r = await evalInFrameOrTop(ctx, expr, match.contextId);
  if (!r?.scrolled) throw new Error(`Failed to scroll ${action.selector} into view`);
  return `Scrolled ${action.selector} into view`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: scroll_into_view auto-falls-back to child frames"
```

---

### Task 10: Wire `select_option` to frame-aware evaluation

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `select_option` case)
- Modify: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-interaction.test.ts`:

```typescript
it('select_option falls back to child frames', async () => {
  (ctx.eval as any).mockResolvedValue(null);
  (ctx.cdp as any).mockImplementation(async (method: string, params: any) => {
    if (method === 'Runtime.evaluate' && params.contextId === undefined) return { result: {} };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 8 };
    if (method === 'Runtime.evaluate' && params.contextId === 8) {
      if (params.returnByValue) return { result: { value: { selected: true, optionText: 'Large' } } };
      return { result: { objectId: 'obj' } };
    }
  });
  const result = await onInteract(ctx, {
    actions: [{ type: 'select_option', selector: '#size', value: 'lg' }],
  }, {});
  expect(result.content[0].text).toContain('Selected');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts -t "select_option falls back"`
Expected: FAIL.

- [ ] **Step 3: Modify `select_option` case**

Rewrite the case (around line 475–500) so the option-matching eval runs in `match.contextId`:

```typescript
case 'select_option': {
  const selectorExpr = ctx.getSelectorExpression(action.selector);
  const match = await resolveInFrames(ctx, selectorExpr);
  if (!match) throw new Error(`Element not found: ${action.selector}`);
  const target = JSON.stringify(action.value);
  const expr = `
    (() => {
      const el = ${selectorExpr};
      if (!el || el.tagName !== 'SELECT') return { selected: false, reason: 'not-a-select' };
      const target = ${target};
      let matched = null;
      for (const opt of el.options) {
        if (opt.value === target || opt.text === target || opt.text.includes(target)) { matched = opt; break; }
      }
      if (!matched) return { selected: false, reason: 'no-option', available: Array.from(el.options).map(o => o.text) };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, matched.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: true, optionText: matched.text };
    })()
  `;
  const r = await evalInFrameOrTop(ctx, expr, match.contextId);
  if (!r?.selected) throw new Error(`Failed to select in ${action.selector}: ${r?.reason ?? 'unknown'}`);
  return `Selected "${r.optionText}" in ${action.selector}`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: select_option auto-falls-back to child frames"
```

---

### Task 11: Wire `hover` action to frame-aware coordinates

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `hover` case)
- Modify: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-interaction.test.ts`:

```typescript
it('hover falls back to iframe coordinates when top-frame selector misses', async () => {
  (ctx.getElementCenter as any).mockRejectedValue(new Error('Element not found'));
  (ctx.cdp as any).mockImplementation(async (method: string, params: any) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
    if (method === 'Runtime.evaluate') return { result: { objectId: 'obj' } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 1 } };
    if (method === 'DOM.getBoxModel') return { model: { content: [200, 100, 240, 100, 240, 140, 200, 140] } };
    if (method === 'Input.dispatchMouseEvent') return {};
  });
  const result = await onInteract(ctx, {
    actions: [{ type: 'hover', selector: '#tooltip-trigger' }],
  }, {});
  expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ x: 220, y: 120, type: 'mouseMoved' }));
  expect(result.content[0].text).toContain('Hovered');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts -t "hover falls back"`
Expected: FAIL.

- [ ] **Step 3: Modify `hover` case**

Replace the `hover` case (around line 375–379). Replace `ctx.getElementCenter(action.selector)` with `getCenterInFrame(ctx, action.selector)`:

```typescript
case 'hover': {
  const { x, y } = await getCenterInFrame(ctx, action.selector);
  await moveCursorTo(ctx, x, y, sessionId);
  return `Hovered ${action.selector}`;
}
```

Add to imports: `import { resolveInFrames, evalInFrameOrTop, getCenterInFrame } from './frames';`

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: hover action auto-falls-back to child frames"
```

---

### Task 12: Wire `type` action to frame-aware focus + verification

`type` currently (1) focuses the element via top-frame eval, (2) dispatches keyboard events via CDP, (3) reads back `el.value` via top-frame eval. Focus and read-back need to run in the element's frame context; keyboard dispatch routes to the focused element regardless of frame.

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `type` case)
- Modify: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-interaction.test.ts`:

```typescript
it('type falls back to child frames for focus and verification', async () => {
  (ctx.eval as any).mockResolvedValue(null); // top-frame focus finds nothing
  (ctx.cdp as any).mockImplementation(async (method: string, params: any) => {
    if (method === 'Runtime.evaluate' && params.contextId === undefined) return { result: {} };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 12 };
    if (method === 'Runtime.evaluate' && params.contextId === 12) {
      if (params.returnByValue) {
        if (params.expression.includes('.value')) return { result: { value: 'hello' } };
        return { result: { value: { focused: true } } };
      }
      return { result: { objectId: 'obj' } };
    }
    if (method === 'Input.dispatchKeyEvent') return {};
  });
  const result = await onInteract(ctx, {
    actions: [{ type: 'type', selector: '#email', text: 'hello' }],
  }, {});
  expect(result.content[0].text).toContain('Typed');
  // Keyboard events were still dispatched
  expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.anything());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts -t "type falls back"`
Expected: FAIL.

- [ ] **Step 3: Modify `type` case**

Rewrite the case (around line 326–342) so focus + read-back use `resolveInFrames` + `evalInFrameOrTop`. Keep keyboard dispatch unchanged (targets the focused element).

```typescript
case 'type': {
  let contextId: number | null = null;
  if (action.selector) {
    const selectorExpr = ctx.getSelectorExpression(action.selector);
    const match = await resolveInFrames(ctx, selectorExpr);
    if (!match) throw new Error(`Element not found: ${action.selector}`);
    contextId = match.contextId;
    const focusExpr = `
      (() => {
        const el = ${selectorExpr};
        if (!el) return { focused: false };
        el.focus();
        return { focused: document.activeElement === el };
      })()
    `;
    const focusResult = await evalInFrameOrTop(ctx, focusExpr, contextId);
    if (!focusResult?.focused) throw new Error(`Failed to focus ${action.selector}`);
  }
  for (const ch of action.text ?? '') {
    await ctx.cdp('Input.dispatchKeyEvent', { type: 'char', text: ch });
  }
  if (action.selector) {
    const selectorExpr = ctx.getSelectorExpression(action.selector);
    const readExpr = `(() => { const el = ${selectorExpr}; return el ? el.value : null; })()`;
    const finalValue = await evalInFrameOrTop(ctx, readExpr, contextId);
    if (finalValue !== (action.text ?? '')) {
      return `⚠ Typed "${action.text}" into ${action.selector} (unverified — element value is "${finalValue}")`;
    }
    return `Typed "${action.text}" into ${action.selector}`;
  }
  return `Typed "${action.text}"`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: type action auto-falls-back to child frames for focus and readback"
```

---

### Task 13: Wire `click` action to frame-aware coordinates

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `click` case)
- Modify: `server/tests/tools-interaction.test.ts`

`click` currently dispatches `Input.dispatchMouseEvent` then calls `ctx.eval(...elementFromPoint(x,y).click()...)` for the DOM-level click. When the element is in a child frame, `elementFromPoint` in the top frame returns the `<iframe>` element, not the target — the fallback `.click()` must run inside the frame's context instead.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-interaction.test.ts`:

```typescript
it('click falls back to iframe coordinates and frame-scoped DOM click', async () => {
  (ctx.getElementCenter as any).mockRejectedValue(new Error('Element not found'));
  const evalCalls: Array<{ expr: string; contextId: number | undefined }> = [];
  (ctx.cdp as any).mockImplementation(async (method: string, params: any) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 20 };
    if (method === 'Runtime.evaluate') {
      evalCalls.push({ expr: params.expression, contextId: params.contextId });
      if (params.contextId === 20 && !params.returnByValue) return { result: { objectId: 'obj' } };
      if (params.contextId === 20 && params.returnByValue) return { result: { value: undefined } };
      return { result: {} };
    }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 77 } };
    if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } };
    if (method === 'Input.dispatchMouseEvent') return {};
  });
  const result = await onInteract(ctx, {
    actions: [{ type: 'click', selector: '#submit' }],
  }, {});
  expect(ctx.cdp).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ x: 20, y: 20, type: 'mousePressed' }));
  // DOM-level click eval ran in the frame's context (20), not top frame
  const domClick = evalCalls.find(c => c.expr.includes('elementFromPoint') || c.expr.includes('.click()'));
  expect(domClick?.contextId).toBe(20);
  expect(result.content[0].text).toContain('Clicked');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts -t "click falls back"`
Expected: FAIL.

- [ ] **Step 3: Modify `click` case**

Find the `click` case (around line 281–324). When a `selector` is given, use `getCenterInFrame` instead of `ctx.getElementCenter`. When the returned `contextId` is non-null, run the post-dispatch DOM-level click in that frame via `evalInFrameOrTop`. The x/y coordinate path (no selector) is unchanged.

Sketch (merge into the existing case body — preserve surrounding logic for mouse_humanization, smart_waiting, tab-spawn detection):

```typescript
case 'click': {
  let x: number, y: number;
  let clickContextId: number | null = null;
  if (action.selector) {
    const c = await getCenterInFrame(ctx, action.selector);
    x = c.x; y = c.y; clickContextId = c.contextId;
  } else if (typeof action.x === 'number' && typeof action.y === 'number') {
    x = action.x; y = action.y;
  } else {
    throw new Error('Click requires either a selector or x/y coordinates');
  }

  await moveCursorTo(ctx, x, y, sessionId);
  const button = action.button ?? 'left';
  const clickCount = action.clickCount ?? 1;
  await ctx.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
  await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });

  // Post-hoc DOM-level click for navigation handlers — must run in the frame
  // that owns the element so elementFromPoint resolves inside the iframe.
  const domClickExpr = `
    (() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (el) el.click();
    })()
  `;
  await evalInFrameOrTop(ctx, domClickExpr, clickContextId);

  // ... preserve existing smart_waiting + drainSpawnedTabs logic below ...
  return action.selector ? `Clicked ${action.selector}` : `Clicked at (${x}, ${y})`;
}
```

**Note:** preserve the existing mouse_humanization and post-click hooks — only change the selector resolution and the DOM-click `ctx.eval` → `evalInFrameOrTop` lines. Read the full current case before editing to avoid dropping features.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts`
Expected: ALL PASS (including existing click tests — no regressions).

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: click action auto-falls-back to child frames"
```

---

### Task 14: Wire `force_pseudo_state` to frame-aware node resolution

`force_pseudo_state` uses `DOM.getDocument` + `DOM.querySelector` which only hits the top-frame document. To support iframe elements: resolve via `resolveInFrames` → get the `objectId` → translate to `nodeId` via `DOM.requestNode` → pass `nodeId` to `CSS.forcePseudoState`.

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `force_pseudo_state` case)
- Modify: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-interaction.test.ts`:

```typescript
it('force_pseudo_state falls back to child frames', async () => {
  (ctx.cdp as any).mockImplementation(async (method: string, params: any) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 0 }; // top-frame miss
    if (method === 'Runtime.evaluate' && params.contextId === undefined) return { result: {} };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 30 };
    if (method === 'Runtime.evaluate' && params.contextId === 30) return { result: { objectId: 'obj-in-frame' } };
    if (method === 'DOM.requestNode') return { nodeId: 456 };
    if (method === 'CSS.forcePseudoState') return {};
  });
  const result = await onInteract(ctx, {
    actions: [{ type: 'force_pseudo_state', selector: '#btn', pseudoStates: ['hover'] }],
  }, {});
  expect(ctx.cdp).toHaveBeenCalledWith('CSS.forcePseudoState', expect.objectContaining({ nodeId: 456, forcedPseudoClasses: ['hover'] }));
  expect(result.content[0].text).toContain('Forced');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts -t "force_pseudo_state falls back"`
Expected: FAIL.

- [ ] **Step 3: Modify `force_pseudo_state` case**

Replace the case (around line 736–750):

```typescript
case 'force_pseudo_state': {
  const pseudoStates = action.pseudoStates || [];
  // Try top-frame DOM.querySelector first (preserves existing behavior)
  const doc = await ctx.cdp('DOM.getDocument', {});
  const topResult = await ctx.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: action.selector });
  let nodeId = topResult.nodeId;
  if (!nodeId) {
    const selectorExpr = ctx.getSelectorExpression(action.selector);
    const match = await findElementInFrames(ctx, selectorExpr);
    if (!match) throw new Error(`Element not found: ${action.selector}`);
    const req = await ctx.cdp('DOM.requestNode', { objectId: match.objectId });
    nodeId = req.nodeId;
  }
  if (!nodeId) throw new Error(`Element not found: ${action.selector}`);
  await ctx.cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudoStates });
  return `Forced pseudo-states [${pseudoStates.join(', ')}] on ${action.selector}`;
}
```

Add to imports if not present: `import { findElementInFrames, ... } from './frames';`

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: force_pseudo_state auto-falls-back to child frames"
```

---

### Task 15: Wire `select_custom` to frame-aware coordinates + evaluation

`select_custom` is the most complex: it (1) clicks a trigger element, (2) waits 300ms for a dropdown to render, (3) finds and clicks a matching option, (4) verifies the trigger's text changed. All four steps need to run frame-aware when the trigger lives in an iframe.

**Files:**
- Modify: `server/src/tools/interaction.ts` (the `select_custom` case)
- Modify: `server/tests/tools-interaction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/tests/tools-interaction.test.ts`:

```typescript
it('select_custom falls back to child frames for trigger and option click', async () => {
  (ctx.getElementCenter as any).mockRejectedValue(new Error('Element not found'));
  (ctx.eval as any).mockResolvedValue(null);
  (ctx.cdp as any).mockImplementation(async (method: string, params: any) => {
    if (method === 'Runtime.evaluate' && params.contextId === undefined) return { result: {} };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'c' }, childFrames: [] }] } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 50 };
    if (method === 'Runtime.evaluate' && params.contextId === 50) {
      if (params.returnByValue) {
        if (params.expression.includes('optionText')) return { result: { value: { matched: true, optionText: 'Blue' } } };
        if (params.expression.includes('triggerText')) return { result: { value: { verified: true } } };
      }
      return { result: { objectId: 'obj' } };
    }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 11 } };
    if (method === 'DOM.getBoxModel') return { model: { content: [50, 50, 80, 50, 80, 70, 50, 70] } };
    if (method === 'Input.dispatchMouseEvent') return {};
  });
  const result = await onInteract(ctx, {
    actions: [{ type: 'select_custom', selector: '[role=combobox]', value: 'Blue' }],
  }, {});
  expect(result.content[0].text).toContain('Selected "Blue"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts -t "select_custom falls back"`
Expected: FAIL.

- [ ] **Step 3: Modify `select_custom` case**

Read the current case (around line 502–674) in full before editing. Replace:
- `ctx.getElementCenter(triggerSelector)` → `getCenterInFrame(ctx, triggerSelector)`, capture the returned `contextId` as `frameContextId`
- Every `ctx.eval(...)` call inside the case → `evalInFrameOrTop(ctx, <same expr>, frameContextId)`
- The post-click DOM-level click (the `elementFromPoint` eval) → `evalInFrameOrTop(ctx, expr, frameContextId)`
- The final trigger-text verification eval → `evalInFrameOrTop(ctx, expr, frameContextId)`

Do NOT change the 300ms `ctx.sleep` or any CDP mouse dispatches — those are frame-agnostic.

**Verification after editing:** `grep -n "ctx.eval(" interaction.ts` in the `select_custom` case should return zero matches. Every eval inside that case must go through `evalInFrameOrTop`.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tools-interaction.test.ts`
Expected: ALL PASS (including existing select_custom tests — no regressions).

- [ ] **Step 5: Commit**

```bash
git add server/src/tools/interaction.ts server/tests/tools-interaction.test.ts
git commit -m "feat: select_custom auto-falls-back to child frames"
```

---

## Phase 3: Cleanup

### Task 16: Audit `tips.ts` for iframe-related hints that are now obsolete

If any contextual tip in `server/src/tips.ts` suggests agents use `browser_evaluate` for iframe traversal, remove or update it — the fallback is now automatic and the tip will mislead agents.

**Files:**
- Modify: `server/src/tips.ts` (possibly)
- Modify: `server/tests/tips.test.ts` (possibly)

- [ ] **Step 1: Grep for iframe-related tip content**

Run: `grep -n -i "iframe\|frame" /Users/jahcrispy646/Projects/Github/supersurf/server/src/tips.ts`

If no matches → skip to Step 4 (no changes needed, commit nothing).
If matches → proceed.

- [ ] **Step 2: For each match, read the surrounding tip and decide**

- If the tip says "use browser_evaluate to walk iframes" → DELETE the tip and its test.
- If the tip mentions iframes but the advice is still valid → leave unchanged.

- [ ] **Step 3: Run tests to verify pass**

Run: `cd server && npx vitest run tests/tips.test.ts`
Expected: ALL PASS.

- [ ] **Step 4: Commit (if changes were made)**

```bash
git add server/src/tips.ts server/tests/tips.test.ts
git commit -m "chore: remove obsolete iframe-traversal hints now that fallback is automatic"
```

---

### Task 17: Update `CLAUDE.md` architecture notes

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the Server architecture section**

Open `CLAUDE.md`, locate the `### Server (`server/src/`)` table. Find the row for `tools/` and the mention of `findElementInFrames`.

- [ ] **Step 2: Add a new row for `tools/frames.ts`**

Insert after the `tools/` row:

```
| `tools/frames.ts` | Frame-aware primitives shared by all selector-based actions: `findElementInFrames` (DFS child frames via isolated worlds), `resolveInFrames` (top-frame-first with fallback), `evalInFrameOrTop` (context-aware evaluate), `getCenterInFrame` (viewport coords via `DOM.getBoxModel`). Every `browser_interact` action with a `selector` auto-falls-back to child frames on top-frame miss. |
```

- [ ] **Step 3: Update the "Design Principles" section**

Find the "Content-script-first for DOM interaction" paragraph. Append a note:

```
**Auto-fallback iframe resolution.** `browser_interact` actions with a `selector` first try the top frame, then DFS-walk child frames via `Page.createIsolatedWorld` on miss. This matches how humans interact with the page (they don't think about frames) and eliminates a class of agent failure where iframe-nested elements trigger "Element not found" and force a `browser_evaluate` spiral.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document frames.ts module and auto-fallback iframe resolution"
```

---

## Self-Review Checklist

Before handing off:

1. **Spec coverage.** Every action type listed in the sticky note (`click`, `type`, `clear`, `hover`, `wait`, `scroll_into_view`, `select_option`, `select_custom`, `force_pseudo_state`) has a dedicated task — plus `scroll_to`/`scroll_by` since they accept selectors too. `file_upload` is already iframe-aware; no task needed.
2. **No schema change.** Confirmed — no task touches `server/src/tools/schemas.ts`.
3. **No extension change.** Confirmed — no task touches `extension/`.
4. **Type consistency.** Helper signatures in Tasks 2–5 are used consistently across Tasks 6–15. Action handlers receive `{ objectId, contextId }` or `{ x, y, contextId }`; `evalInFrameOrTop` takes `contextId: number | null`.
5. **Test pattern consistency.** Every action task uses the same mock-cdp pattern, exercises the top-frame-miss path, and asserts the frame-scoped CDP calls fire.
6. **Frequent commits.** Every task ends in a commit.

---

## Execution Handoff

**Recommended:** subagent-driven execution via superpowers:subagent-driven-development. One fresh subagent per task; review after each. Tasks are designed to be independent past Task 5 (all helper work) — after Phase 1 lands, Phase 2 tasks are parallelizable in principle, but serial execution is safer since they all touch `interaction.ts`.
