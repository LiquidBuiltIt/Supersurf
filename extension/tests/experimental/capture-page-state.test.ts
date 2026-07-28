import { describe, it, expect, beforeEach } from 'vitest';
import { capturePageState } from '../../src/experimental/capture-page-state';

/**
 * capturePageState is injected into the page via `chrome.scripting.executeScript({ func })`,
 * which serializes it with `Function.prototype.toString()` and re-evaluates it in a fresh
 * page context — so it references `document`/`window` directly with no imports. There's no
 * jsdom dependency in this package, so these tests build a minimal duck-typed fake DOM
 * (tree of plain objects) and install it as `globalThis.document`/`globalThis.window`,
 * matching the exact surface capturePageState touches: tagName, shadowRoot,
 * getBoundingClientRect(), innerText, form field props, and querySelectorAll('*').
 */

interface FakeNode {
  tagName: string;
  children: FakeNode[];
  shadowRoot?: FakeRoot | null;
  innerText?: string;
  _style?: Record<string, string>;
  getBoundingClientRect: () => { width: number; height: number; top: number; left: number; right: number; bottom: number };
  name?: string;
  id?: string;
  value?: string;
  type?: string;
  checked?: boolean;
  options?: { text: string }[];
  selectedIndex?: number;
}

interface FakeRoot {
  children: FakeNode[];
  querySelectorAll: (selector: string) => FakeNode[];
}

function flattenDescendants(children: FakeNode[]): FakeNode[] {
  const out: FakeNode[] = [];
  for (const child of children) {
    out.push(child);
    out.push(...flattenDescendants(child.children));
  }
  return out;
}

function makeRoot(children: FakeNode[]): FakeRoot {
  return {
    children,
    querySelectorAll: () => flattenDescendants(children),
  };
}

function makeElement(tag: string, opts: Partial<FakeNode> & { children?: FakeNode[] } = {}): FakeNode {
  const rect = { width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, ...(opts as any).rect };
  return {
    tagName: tag.toUpperCase(),
    children: opts.children || [],
    shadowRoot: opts.shadowRoot ?? null,
    innerText: opts.innerText,
    _style: opts._style || {},
    getBoundingClientRect: () => rect,
    name: opts.name,
    id: opts.id,
    value: opts.value,
    type: opts.type,
    checked: opts.checked,
    options: opts.options,
    selectedIndex: opts.selectedIndex,
  };
}

function installFakeDom(children: FakeNode[]): void {
  (globalThis as any).document = makeRoot(children);
  (globalThis as any).window = {
    getComputedStyle: (el: FakeNode) => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      ...el._style,
    }),
    innerHeight: 1000,
    innerWidth: 1000,
  };
}

describe('capturePageState — shadow DOM traversal', () => {
  beforeEach(() => {
    delete (globalThis as any).document;
    delete (globalThis as any).window;
  });

  it('produces the same result as before on a page with no shadow roots (non-breaking)', () => {
    const tree = [
      makeElement('div', { innerText: 'Hello' }),
      makeElement('span', { innerText: 'World' }),
    ];
    installFakeDom(tree);

    const state = capturePageState('document');

    expect(state.elementCount).toBe(2);
    expect(state.pageElementCount).toBe(2);
    expect(state.shadowRootCount).toBe(0);
    expect(state.textContent.sort()).toEqual(['Hello', 'World']);
  });

  it('counts and captures text for elements nested inside an open shadow root', () => {
    const shadowButton = makeElement('button', { innerText: 'Shadow Button' });
    const shadowRoot = makeRoot([shadowButton]);
    const host = makeElement('my-widget', { shadowRoot });
    installFakeDom([host]);

    const state = capturePageState('document');

    // Host (light DOM) + button (shadow content) = 2, previously only host was seen.
    expect(state.elementCount).toBe(2);
    expect(state.pageElementCount).toBe(2);
    expect(state.shadowRootCount).toBe(1);
    expect(state.textContent).toContain('Shadow Button');
  });

  it('walks multiple shadow root levels breadth-first (nested web components)', () => {
    const innerLeaf = makeElement('span', { innerText: 'Deeply nested' });
    const innerShadowRoot = makeRoot([innerLeaf]);
    const innerHost = makeElement('inner-widget', { shadowRoot: innerShadowRoot });

    const outerShadowRoot = makeRoot([innerHost]);
    const outerHost = makeElement('outer-widget', { shadowRoot: outerShadowRoot });

    installFakeDom([outerHost]);

    const state = capturePageState('document');

    // outerHost + innerHost + innerLeaf = 3 elements across 2 shadow levels.
    expect(state.elementCount).toBe(3);
    expect(state.shadowRootCount).toBe(2);
    expect(state.textContent).toContain('Deeply nested');
  });

  it('does not throw on a closed shadow root and leaves it uncounted, while sibling open roots still resolve', () => {
    // Closed shadow roots surface as el.shadowRoot === null — indistinguishable
    // from "no shadow root at all" from script, so the walk must just skip it.
    const closedHost = makeElement('closed-widget', { shadowRoot: null });

    const openLeaf = makeElement('p', { innerText: 'Open content' });
    const openShadowRoot = makeRoot([openLeaf]);
    const openHost = makeElement('open-widget', { shadowRoot: openShadowRoot });

    installFakeDom([closedHost, openHost]);

    expect(() => capturePageState('document')).not.toThrow();

    const state = capturePageState('document');
    // closedHost + openHost (light DOM) + openLeaf (shadow content) = 3.
    expect(state.elementCount).toBe(3);
    expect(state.shadowRootCount).toBe(1);
    expect(state.textContent).toContain('Open content');
  });

  it('captures form field values from inputs nested inside a shadow root', () => {
    const shadowInput = makeElement('input', { name: 'email', value: 'a@example.com' });
    const shadowRoot = makeRoot([shadowInput]);
    const host = makeElement('form-widget', { shadowRoot });
    installFakeDom([host]);

    const state = capturePageState('document');

    expect(state.formValues.email).toBe('a@example.com');
  });
});
