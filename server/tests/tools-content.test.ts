import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onSnapshot, onLookup, onExtractContent } from '../src/tools/content';
import { getSelectorExpression } from '../src/tools/lib/element-resolver';
import type { ToolContext } from '../src/tools/lib/types';

// ── minimal fake DOM (mirrors server/tests/shadow-walker.test.ts) ─────────
// queryDeep only touches querySelector/querySelectorAll/.shadowRoot, so this
// tiny hand-rolled tree exercises real shadow traversal without a browser
// engine. Extended with childNodes/textContent/nodeType so the markdown
// walker in onExtractContent can run against it too.

class FakeTextNode {
  nodeType = 3; // Node.TEXT_NODE
  textContent: string;
  constructor(text: string) {
    this.textContent = text;
  }
}

class FakeElement {
  nodeType = 1; // Node.ELEMENT_NODE
  tagName: string;
  id: string;
  classes: string[];
  attrs: Record<string, string>;
  children: FakeElement[] = []; // element-only, used by querySelector traversal
  childNodes: Array<FakeElement | FakeTextNode> = []; // used by the markdown walker
  shadowRoot: FakeShadowRoot | null = null;

  constructor(tag: string, opts: { id?: string; class?: string; attrs?: Record<string, string> } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = opts.id ?? '';
    this.classes = opts.class ? opts.class.split(/\s+/) : [];
    this.attrs = opts.attrs ?? {};
  }
  append(...kids: Array<FakeElement | FakeTextNode>): this {
    for (const kid of kids) {
      this.childNodes.push(kid);
      if (kid instanceof FakeElement) this.children.push(kid);
    }
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

const FAKE_WINDOW = { getComputedStyle: () => ({ display: 'block' }) };
const FAKE_NODE = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

/** Runs a real (unmocked) onExtractContent page-eval script against a fake DOM. */
function makeRealEval(doc: FakeDocument) {
  return vi.fn(async (expr: string) => {
    // Wrap in parens: expr can start with a newline before `(`, and a bare
    // `return\n(...)` triggers ASI (return-then-semicolon), silently
    // discarding the value. `return (...)` is immune to that.
    const fn = new Function('document', 'window', 'Node', `return (${expr})`);
    return fn(doc, FAKE_WINDOW, FAKE_NODE);
  });
}

function createMockCtx(): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({}) } as any,
    connectionManager: null,
    cdp: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
    getSelectorExpression: vi.fn((s) => `document.querySelector("${s}")`),
    findAlternativeSelectors: vi.fn().mockResolvedValue([]),
    formatResult: vi.fn((_n, r) => ({ content: [{ type: 'text', text: JSON.stringify(r) }] })),
    error: vi.fn((msg) => ({ content: [{ type: 'text', text: msg }], isError: true })),
  };
}

describe('onSnapshot()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('returns formatted accessibility tree', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      nodes: [
        { role: { value: 'button' }, name: { value: 'Submit' }, depth: 0 },
        { role: { value: 'textbox' }, name: { value: 'Email' }, depth: 1 },
      ],
    });

    const result = await onSnapshot(ctx, {});
    expect(result.content[0].text).toContain('[button] Submit');
    expect(result.content[0].text).toContain('[textbox] Email');
  });

  it('skips none/generic roles', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      nodes: [
        { role: { value: 'none' }, name: { value: 'skip' }, depth: 0 },
        { role: { value: 'generic' }, name: { value: 'skip2' }, depth: 0 },
        { role: { value: 'heading' }, name: { value: 'Title' }, depth: 0 },
      ],
    });

    const result = await onSnapshot(ctx, {});
    expect(result.content[0].text).not.toContain('skip');
    expect(result.content[0].text).toContain('[heading] Title');
  });

  it('handles empty tree', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({ nodes: [] });
    const result = await onSnapshot(ctx, {});
    expect(result.content[0].text).toContain('Empty accessibility tree');
  });

  it('returns raw result when rawResult is true', async () => {
    const mockData = { nodes: [{ role: { value: 'button' } }] };
    (ctx.ext.sendCmd as any).mockResolvedValue(mockData);
    const result = await onSnapshot(ctx, { rawResult: true });
    expect(result).toMatchObject({ nodes: mockData.nodes });
  });

  it('includes form fields section when forms are present', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      nodes: [
        { role: { value: 'textbox' }, name: { value: 'Email' }, depth: 1 },
      ],
      formFields: [
        { selector: 'input#email', tag: 'input', type: 'email', name: 'email', value: '', required: true, label: 'Email' },
        { selector: 'select#role', tag: 'select', type: null, name: 'role', value: 'engineer', required: false, label: 'Role', options: ['designer', 'engineer', 'pm'] },
      ],
    });

    const result = await onSnapshot(ctx, {});
    expect(result.content[0].text).toContain('Form Fields');
    expect(result.content[0].text).toContain('input#email');
    expect(result.content[0].text).toContain('email');
    expect(result.content[0].text).toContain('required');
    expect(result.content[0].text).toContain('select#role');
    expect(result.content[0].text).toContain('engineer');
    expect(result.content[0].text).toContain('designer');
  });

  it('omits form fields section when no forms present', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      nodes: [
        { role: { value: 'heading' }, name: { value: 'Welcome' }, depth: 0 },
      ],
    });

    const result = await onSnapshot(ctx, {});
    expect(result.content[0].text).not.toContain('Form Fields');
  });

  it('coalesces adjacent InlineTextBox siblings under the same parent', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      nodes: [
        { nodeId: '1', parentId: null, role: { value: 'StaticText' }, name: { value: '' }, depth: 0 },
        { nodeId: '2', parentId: '1', role: { value: 'InlineTextBox' }, name: { value: 'John' }, depth: 1 },
        { nodeId: '3', parentId: '1', role: { value: 'InlineTextBox' }, name: { value: 'Doe' }, depth: 1 },
        { nodeId: '4', parentId: '1', role: { value: 'InlineTextBox' }, name: { value: '@' }, depth: 1 },
        { nodeId: '5', parentId: '1', role: { value: 'InlineTextBox' }, name: { value: 'example' }, depth: 1 },
      ],
    });

    const result = await onSnapshot(ctx, {});
    const text = result.content[0].text;
    // Should appear as a single coalesced StaticText-ish node with joined name
    expect(text).toContain('John Doe @ example');
    // Should appear only once
    const matches = text.match(/InlineTextBox|StaticText/g) || [];
    // No duplicated InlineTextBox entries
    const inlineCount = (text.match(/\[InlineTextBox\]/g) || []).length;
    expect(inlineCount).toBeLessThanOrEqual(1);
  });

  it('does not coalesce InlineTextBox siblings with different parents', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      nodes: [
        { nodeId: '1', parentId: 'a', role: { value: 'InlineTextBox' }, name: { value: 'Alpha' }, depth: 1 },
        { nodeId: '2', parentId: 'b', role: { value: 'InlineTextBox' }, name: { value: 'Beta' }, depth: 1 },
      ],
    });

    const result = await onSnapshot(ctx, {});
    const text = result.content[0].text;
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    // Not merged into "Alpha Beta"
    expect(text).not.toMatch(/Alpha Beta/);
  });

  it('does not merge InlineTextBox across non-InlineTextBox sibling', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      nodes: [
        { nodeId: '1', parentId: 'p', role: { value: 'InlineTextBox' }, name: { value: 'First' }, depth: 1 },
        { nodeId: '2', parentId: 'p', role: { value: 'link' }, name: { value: 'Link' }, depth: 1 },
        { nodeId: '3', parentId: 'p', role: { value: 'InlineTextBox' }, name: { value: 'Second' }, depth: 1 },
      ],
    });

    const result = await onSnapshot(ctx, {});
    const text = result.content[0].text;
    expect(text).toContain('First');
    expect(text).toContain('Second');
    expect(text).toContain('[link] Link');
    // Not merged across the link
    expect(text).not.toMatch(/First Second/);
  });

  it('joins InlineTextBox names with a single space separator', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      nodes: [
        { nodeId: '1', parentId: 'p', role: { value: 'InlineTextBox' }, name: { value: '  Hello  ' }, depth: 1 },
        { nodeId: '2', parentId: 'p', role: { value: 'InlineTextBox' }, name: { value: '\nworld\n' }, depth: 1 },
      ],
    });

    const result = await onSnapshot(ctx, {});
    const text = result.content[0].text;
    expect(text).toContain('Hello world');
    expect(text).not.toMatch(/Hello {2,}world/);
  });

  it('preserves InlineTextBox coalescing in raw result', async () => {
    (ctx.ext.sendCmd as any).mockResolvedValue({
      nodes: [
        { nodeId: '1', parentId: 'p', role: { value: 'InlineTextBox' }, name: { value: 'foo' }, depth: 1 },
        { nodeId: '2', parentId: 'p', role: { value: 'InlineTextBox' }, name: { value: 'bar' }, depth: 1 },
      ],
    });

    const result = await onSnapshot(ctx, { rawResult: true });
    // Raw result should pass through untouched (no coalescing)
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].name.value).toBe('foo');
    expect(result.nodes[1].name.value).toBe('bar');
  });

  it('includes form fields in raw result', async () => {
    const mockData = {
      nodes: [{ role: { value: 'button' } }],
      formFields: [{ selector: 'input#name', tag: 'input', type: 'text', name: 'name', value: 'John' }],
    };
    (ctx.ext.sendCmd as any).mockResolvedValue(mockData);
    const result = await onSnapshot(ctx, { rawResult: true });
    expect(result.formFields).toBeDefined();
    expect(result.formFields[0].selector).toBe('input#name');
  });
});

describe('onLookup()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('returns found elements', async () => {
    (ctx.eval as any).mockResolvedValue({
      matches: [
        { selector: 'button#submit', visible: true, text: 'Submit', tag: 'button', x: 100, y: 200 },
      ],
      total: 1,
    });

    const result = await onLookup(ctx, { text: 'Submit' }, {});
    expect(result.content[0].text).toContain('Submit');
    expect(result.content[0].text).toContain('button#submit');
  });

  it('returns message when no elements found', async () => {
    (ctx.eval as any).mockResolvedValue({ matches: [], total: 0 });
    const result = await onLookup(ctx, { text: 'nonexistent' }, {});
    expect(result.content[0].text).toContain('No elements found');
  });

  it('returns raw result when rawResult is true', async () => {
    const mockData = { matches: [{ selector: 'div' }], total: 1 };
    (ctx.eval as any).mockResolvedValue(mockData);
    const result = await onLookup(ctx, { text: 'test' }, { rawResult: true });
    expect(result).toEqual(mockData);
  });

  it('includes form field metadata for input elements', async () => {
    (ctx.eval as any).mockResolvedValue({
      matches: [
        {
          selector: 'input#email',
          visible: true,
          text: '',
          tag: 'input',
          x: 100, y: 200,
          width: 300, height: 40,
          formField: { type: 'email', name: 'email', value: 'test@x.com', required: true, label: 'Email Address' },
        },
      ],
      total: 1,
    });

    const result = await onLookup(ctx, { text: 'Email' }, {});
    expect(result.content[0].text).toContain('type=email');
    expect(result.content[0].text).toContain('value="test@x.com"');
    expect(result.content[0].text).toContain('required');
    expect(result.content[0].text).toContain('Email Address');
  });

  it('includes select options in lookup form field metadata', async () => {
    (ctx.eval as any).mockResolvedValue({
      matches: [
        {
          selector: 'select#dept',
          visible: true,
          text: 'Engineering',
          tag: 'select',
          x: 100, y: 200,
          width: 200, height: 40,
          formField: { type: null, name: 'department', value: 'eng', required: false, label: 'Department', options: ['Design', 'Engineering', 'PM'] },
        },
      ],
      total: 1,
    });

    const result = await onLookup(ctx, { text: 'Engineering' }, {});
    expect(result.content[0].text).toContain('options:');
    expect(result.content[0].text).toContain('Design');
    expect(result.content[0].text).toContain('Engineering');
  });
});

describe('onExtractContent()', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it('returns extracted markdown lines', async () => {
    (ctx.eval as any).mockResolvedValue({
      lines: ['# Hello', 'Some content', 'More content'],
    });

    const result = await onExtractContent(ctx, { mode: 'auto' }, {});
    expect(result.content[0].text).toContain('# Hello');
    expect(result.content[0].text).toContain('Some content');
  });

  it('respects offset and max_lines', async () => {
    (ctx.eval as any).mockResolvedValue({
      lines: ['line0', 'line1', 'line2', 'line3', 'line4'],
    });

    const result = await onExtractContent(ctx, { mode: 'full', offset: 1, max_lines: 2 }, { rawResult: true });
    expect(result.lines).toEqual(['line1', 'line2']);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(5);
  });

  it('handles error from content extraction', async () => {
    (ctx.eval as any).mockResolvedValue({ error: 'No content element found' });
    await onExtractContent(ctx, { mode: 'selector', selector: '.missing' }, {});
    expect(ctx.error).toHaveBeenCalledWith('No content element found', expect.anything());
  });

  it('returns raw result when rawResult is true', async () => {
    (ctx.eval as any).mockResolvedValue({ lines: ['hello'] });
    const result = await onExtractContent(ctx, {}, { rawResult: true });
    expect(result.lines).toEqual(['hello']);
    expect(result.total).toBe(1);
  });

  it('routes selector-mode root resolution through ctx.getSelectorExpression rather than a hand-rolled querySelector', async () => {
    (ctx.getSelectorExpression as any).mockReturnValue('window.__SHADOW_TEST_MARKER__');
    (ctx.eval as any).mockResolvedValue({ lines: [] });

    await onExtractContent(ctx, { mode: 'selector', selector: '#deep' }, {});

    expect(ctx.getSelectorExpression).toHaveBeenCalledWith('#deep');
    expect((ctx.eval as any).mock.calls[0][0]).toContain('window.__SHADOW_TEST_MARKER__');
    expect((ctx.eval as any).mock.calls[0][0]).not.toContain('document.querySelector(');
  });

  it('pierces an open shadow root: selector mode can now extract content from a shadow-nested root', async () => {
    const doc = new FakeDocument();
    const host = new FakeElement('my-host');
    doc.append(host);
    const article = new FakeElement('article', { id: 'shadow-article' });
    article.append(new FakeTextNode('Shadow content marker'));
    host.attachShadow()!.append(article);

    // Sanity check: a plain querySelector genuinely misses this element.
    expect(doc.querySelector('#shadow-article')).toBeNull();

    ctx.getSelectorExpression = getSelectorExpression;
    ctx.eval = makeRealEval(doc);

    const result = await onExtractContent(ctx, { mode: 'selector', selector: '#shadow-article' }, {});
    expect(ctx.error).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('Shadow content marker');
  });

  it('non-breaking: selector mode still extracts from the light-DOM element when the same selector also matches inside a shadow root', async () => {
    const doc = new FakeDocument();
    const lightArticle = new FakeElement('article', { class: 'content' });
    lightArticle.append(new FakeTextNode('Light content marker'));
    const host = new FakeElement('my-host');
    doc.append(lightArticle, host);
    const shadowArticle = new FakeElement('article', { class: 'content' });
    shadowArticle.append(new FakeTextNode('Shadow content marker'));
    host.attachShadow()!.append(shadowArticle);

    ctx.getSelectorExpression = getSelectorExpression;
    ctx.eval = makeRealEval(doc);

    const result = await onExtractContent(ctx, { mode: 'selector', selector: '.content' }, {});
    expect(result.content[0].text).toContain('Light content marker');
    expect(result.content[0].text).not.toContain('Shadow content marker');
  });
});
