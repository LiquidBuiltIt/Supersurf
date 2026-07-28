import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  onWindow, onDialog,
  onVerifyTextVisible, onVerifyElementVisible,
  onListExtensions,
  onPerformanceMetrics,
} from '../src/tools/misc';
import { getSelectorExpression } from '../src/tools/lib/element-resolver';
import type { ToolContext } from '../src/tools/lib/types';

// ── minimal fake DOM (mirrors server/tests/shadow-walker.test.ts) ─────────
// queryDeep/queryAllDeep only touch querySelector/querySelectorAll/.shadowRoot,
// so this tiny hand-rolled tree is enough to exercise real shadow traversal
// without a browser engine.

class FakeElement {
  tagName: string;
  id: string;
  classes: string[];
  attrs: Record<string, string>;
  children: FakeElement[] = [];
  shadowRoot: FakeShadowRoot | null = null;

  constructor(tag: string, opts: { id?: string; class?: string; attrs?: Record<string, string> } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = opts.id ?? '';
    this.classes = opts.class ? opts.class.split(/\s+/) : [];
    this.attrs = opts.attrs ?? {};
  }
  append(...kids: FakeElement[]): this {
    this.children.push(...kids);
    return this;
  }
  attachShadow(): FakeShadowRoot {
    this.shadowRoot = new FakeShadowRoot();
    return this.shadowRoot;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return collect(this, selector);
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getBoundingClientRect() {
    return { width: 10, height: 10, left: 0, top: 0 };
  }
}

class FakeShadowRoot {
  children: FakeElement[] = [];
  append(...kids: FakeElement[]): this {
    this.children.push(...kids);
    return this;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return collect(this, selector);
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  children: FakeElement[] = [];
  append(...kids: FakeElement[]): this {
    this.children.push(...kids);
    return this;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return collect(this, selector);
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function selectorMatches(el: FakeElement, selector: string): boolean {
  if (selector === '*') return true;
  const tagMatch = selector.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch && el.tagName.toLowerCase() !== tagMatch[0].toLowerCase()) return false;
  const idMatch = selector.match(/#([\w-]+)/);
  if (idMatch && el.id !== idMatch[1]) return false;
  const classMatches = Array.from(selector.matchAll(/\.([\w-]+)/g)).map((m) => m[1]);
  if (classMatches.length && !classMatches.every((c) => el.classes.includes(c))) return false;
  return true;
}

function collect(root: { children: FakeElement[] }, selector: string): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (node: { children: FakeElement[] }) => {
    for (const child of node.children) {
      if (selectorMatches(child, selector)) out.push(child);
      walk(child); // light-tree descent only — never crosses into child.shadowRoot
    }
  };
  walk(root);
  return out;
}

const FAKE_WINDOW = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };

/** Runs a real (unmocked) getSelectorExpression()-produced script against a fake DOM. */
function makeRealEval(doc: FakeDocument) {
  return vi.fn(async (expr: string) => {
    // Wrap in parens: expr can start with a newline before `(`, and a bare
    // `return\n(...)` triggers ASI (return-then-semicolon), silently
    // discarding the value. `return (...)` is immune to that.
    const fn = new Function('document', 'window', `return (${expr})`);
    return fn(doc, FAKE_WINDOW);
  });
}

function createMockCtx(): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({ success: true }) } as any,
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

describe('onWindow()', () => {
  it('forwards window action to extension', async () => {
    const ctx = createMockCtx();
    await onWindow(ctx, { action: 'maximize' }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('window', expect.objectContaining({ action: 'maximize' }));
    expect(ctx.formatResult).toHaveBeenCalled();
  });

  it('passes resize dimensions', async () => {
    const ctx = createMockCtx();
    await onWindow(ctx, { action: 'resize', width: 1920, height: 1080 }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('window', { action: 'resize', width: 1920, height: 1080 });
  });
});

describe('onDialog()', () => {
  it('accepts a dialog', async () => {
    const ctx = createMockCtx();
    await onDialog(ctx, { accept: true }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('dialog', { accept: true, text: undefined });
  });

  it('dismisses a dialog', async () => {
    const ctx = createMockCtx();
    await onDialog(ctx, { accept: false }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('dialog', { accept: false, text: undefined });
  });

  it('passes prompt text', async () => {
    const ctx = createMockCtx();
    await onDialog(ctx, { accept: true, text: 'answer' }, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('dialog', { accept: true, text: 'answer' });
  });

  it('gets dialog state when no accept param', async () => {
    const ctx = createMockCtx();
    await onDialog(ctx, {}, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('dialog', {});
  });
});

describe('onDialog returns events on both code paths', () => {
  it('with accept: result includes events from the WS response', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue({
      events: [{ type: 'alert', message: 'hi', response: 'accepted', timestamp: 1 }],
    });
    (ctx.formatResult as any).mockImplementation((_name: string, result: any) => result);

    const out = await onDialog(ctx, { accept: true }, {});
    expect(out.events).toHaveLength(1);
  });

  it('with no accept: same shape', async () => {
    const ctx = createMockCtx();
    (ctx.ext.sendCmd as any).mockResolvedValue({
      events: [{ type: 'confirm', message: 'go?', response: 'dismissed', timestamp: 2 }],
    });
    (ctx.formatResult as any).mockImplementation((_name: string, result: any) => result);

    const out = await onDialog(ctx, {}, {});
    expect(out.events).toHaveLength(1);
  });
});

describe('onVerifyTextVisible()', () => {
  it('returns success when text is found', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue(true);
    const result = await onVerifyTextVisible(ctx, { text: 'Hello' }, {});
    expect(result.content[0].text).toContain('✓');
    expect(result.isError).toBeFalsy();
  });

  it('returns error when text is not found', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue(false);
    const result = await onVerifyTextVisible(ctx, { text: 'Missing' }, {});
    expect(result.content[0].text).toContain('✗');
    expect(result.isError).toBe(true);
  });

  it('returns raw result', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue(true);
    const result = await onVerifyTextVisible(ctx, { text: 'test' }, { rawResult: true });
    expect(result).toEqual({ visible: true, text: 'test' });
  });
});

describe('onVerifyElementVisible()', () => {
  it('returns success when element is visible', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue({ exists: true, visible: true });
    const result = await onVerifyElementVisible(ctx, { selector: '#btn' }, {});
    expect(result.content[0].text).toContain('✓');
  });

  it('returns error when element is not visible', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue({ exists: true, visible: false });
    const result = await onVerifyElementVisible(ctx, { selector: '#btn' }, {});
    expect(result.content[0].text).toContain('✗');
    expect(result.isError).toBe(true);
  });

  it('returns error when element does not exist', async () => {
    const ctx = createMockCtx();
    (ctx.eval as any).mockResolvedValue({ exists: false, visible: false });
    const result = await onVerifyElementVisible(ctx, { selector: '.missing' }, {});
    expect(result.isError).toBe(true);
  });

  it('routes selector resolution through ctx.getSelectorExpression rather than a hand-rolled querySelector', async () => {
    const ctx = createMockCtx();
    (ctx.getSelectorExpression as any).mockReturnValue('window.__SHADOW_TEST_MARKER__');
    (ctx.eval as any).mockResolvedValue({ exists: true, visible: true });

    await onVerifyElementVisible(ctx, { selector: '#deep' }, {});

    expect(ctx.getSelectorExpression).toHaveBeenCalledWith('#deep');
    expect((ctx.eval as any).mock.calls[0][0]).toContain('window.__SHADOW_TEST_MARKER__');
    expect((ctx.eval as any).mock.calls[0][0]).not.toContain('document.querySelector(');
  });

  it('pierces an open shadow root: a selector that only matches inside a shadow root is now found and reported visible', async () => {
    const doc = new FakeDocument();
    const host = new FakeElement('my-host');
    doc.append(host);
    const shadowOnly = new FakeElement('button', { id: 'shadow-btn' });
    host.attachShadow()!.append(shadowOnly);

    // Confirm a plain querySelector genuinely misses this element (sanity check
    // that the fixture is actually testing shadow piercing).
    expect(doc.querySelector('#shadow-btn')).toBeNull();

    const ctx = createMockCtx();
    ctx.getSelectorExpression = getSelectorExpression;
    ctx.eval = makeRealEval(doc);

    const result = await onVerifyElementVisible(ctx, { selector: '#shadow-btn' }, {});
    expect(result.content[0].text).toContain('✓');
    expect(result.isError).toBeFalsy();
  });

  it('non-breaking: a selector matching both a light-DOM element and a same-selector shadow element still resolves to the light element', async () => {
    const doc = new FakeDocument();
    const lightEl = new FakeElement('div', { class: 'x' });
    const host = new FakeElement('my-host');
    doc.append(lightEl, host);
    host.attachShadow()!.append(new FakeElement('div', { class: 'x' }));

    // Independently confirm getSelectorExpression resolves the light element
    // by identity (mirrors shadow-walker.test.ts's end-to-end assertion).
    (globalThis as any).document = doc;
    try {
      const expr = getSelectorExpression('.x');
      const resolved = new Function(`return ${expr}`)();
      expect(resolved).toBe(lightEl);
    } finally {
      delete (globalThis as any).document;
    }

    const ctx = createMockCtx();
    ctx.getSelectorExpression = getSelectorExpression;
    ctx.eval = makeRealEval(doc);

    const result = await onVerifyElementVisible(ctx, { selector: '.x' }, {});
    expect(result.content[0].text).toContain('✓');
  });
});

describe('onListExtensions()', () => {
  it('forwards to extension and formats result', async () => {
    const ctx = createMockCtx();
    await onListExtensions(ctx, {});
    expect(ctx.ext.sendCmd).toHaveBeenCalledWith('listExtensions', {});
    expect(ctx.formatResult).toHaveBeenCalled();
  });
});

describe('onDialog action routing', () => {
  function makeCtx() {
    const sendCmd = vi.fn().mockResolvedValue({ dialog: null });
    const ctx: any = {
      ext: { sendCmd },
      formatResult: (_name: string, r: any) => r,
    };
    return { ctx, sendCmd };
  }

  it('passes action:view through to the dialog command', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, { action: 'view' }, {});
    expect(sendCmd).toHaveBeenCalledWith('dialog', { action: 'view', text: undefined });
  });

  it('passes action:accept with text', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, { action: 'accept', text: 'Alice' }, {});
    expect(sendCmd).toHaveBeenCalledWith('dialog', { action: 'accept', text: 'Alice' });
  });

  it('passes action:dismiss through', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, { action: 'dismiss' }, {});
    expect(sendCmd).toHaveBeenCalledWith('dialog', { action: 'dismiss', text: undefined });
  });

  it('legacy accept:true still works (no action)', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, { accept: true, text: 'x' }, {});
    expect(sendCmd).toHaveBeenCalledWith('dialog', { accept: true, text: 'x' });
  });

  it('no args sends an empty dialog command (view)', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, {}, {});
    expect(sendCmd).toHaveBeenCalledWith('dialog', {});
  });

  it('action wins over accept when both present', async () => {
    const { ctx, sendCmd } = makeCtx();
    await onDialog(ctx, { action: 'dismiss', accept: true }, {});
    // action branch fires first; legacy accept is never consulted
    expect(sendCmd).toHaveBeenCalledWith('dialog', { action: 'dismiss', text: undefined });
  });
});

describe('held-dialog notice', () => {
  it('prepends a held-dialog warning when the transport reports a held dialog', async () => {
    // A transport that reports one held dialog on the first consume, then none.
    let drained = false;
    const transport: any = {
      consumeDialogEvents: () => {
        if (drained) return [];
        drained = true;
        return [{
          type: 'beforeunload', message: 'Leave site?', defaultPrompt: '',
          url: 'https://x.com/', hasBrowserHandler: true, timestamp: 1,
        }];
      },
    };
    // prependDialogNotice reads events via ctx.ext.consumeDialogEvents()
    const ctx: any = { ext: transport };
    const result = { content: [{ type: 'text', text: 'navigated' }] };
    const out = (await import('../src/tools/lib/dispatcher'))
      .__testPrependDialogNotice(result, ctx, {});
    expect(out.content[0].text).toMatch(/native beforeunload dialog is OPEN/i);
    expect(out.content[0].text).toMatch(/browser_handle_dialog/);
    expect(out.content[0].text).toMatch(/navigated$/);
  });

  it('includes defaultPrompt for prompt dialogs', async () => {
    const transport: any = {
      consumeDialogEvents: () => [{
        type: 'prompt', message: 'Enter name:', defaultPrompt: 'Alice',
        url: 'https://x.com/', hasBrowserHandler: false, timestamp: 1,
      }],
    };
    const out = (await import('../src/tools/lib/dispatcher'))
      .__testPrependDialogNotice({ content: [{ type: 'text', text: 'x' }] }, { ext: transport } as any, {});
    expect(out.content[0].text).toMatch(/default: "Alice"/);
  });
});

describe('onPerformanceMetrics()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('returns combined CDP and Web Vitals metrics', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      metrics: [{ name: 'JSHeapUsedSize', value: 1000000 }],
    });
    (ctx.eval as any).mockResolvedValue({
      ttfb: 50, fcp: 200, domContentLoaded: 500, load: 800,
    });

    const result = await onPerformanceMetrics(ctx, {});
    expect(result.content[0].text).toContain('TTFB');
    expect(result.content[0].text).toContain('FCP');
    expect(result.content[0].text).toContain('JSHeapUsedSize');
  });

  it('handles null vitals gracefully', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ metrics: [] });
    (ctx.eval as any).mockResolvedValue(null);

    const result = await onPerformanceMetrics(ctx, {});
    expect(result.content[0].text).toContain('Performance Metrics');
  });

  it('returns raw result', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ metrics: [{ name: 'Metric', value: 42 }] });
    (ctx.eval as any).mockResolvedValue({ ttfb: 10 });

    const result = await onPerformanceMetrics(ctx, { rawResult: true });
    expect(result.metrics).toHaveLength(1);
    expect(result.vitals.ttfb).toBe(10);
  });
});
