import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onSnapshot, onLookup, onExtractContent } from '../src/tools/content';
import type { ToolContext } from '../src/tools/lib/types';

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
});
