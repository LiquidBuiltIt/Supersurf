import { describe, it, expect } from 'vitest';
import { QUERY_DEEP_SOURCE, QUERY_ALL_DEEP_SOURCE } from 'shared';
import { getSelectorExpression } from '../src/tools/lib/element-resolver';

// ── minimal fake DOM ──────────────────────────────────────────────────────
// No jsdom/happy-dom dependency in this workspace. queryDeep/queryAllDeep
// only touch `querySelector`/`querySelectorAll`/`.shadowRoot`, so a tiny
// hand-rolled tree exercises the real traversal/ordering logic without a
// browser engine. Selector support is limited to what the tests below need:
// an optional tag, then any number of #id / .class / [attr="value"].

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
  const attrMatch = selector.match(/\[([\w-]+)="([^"]*)"\]/);
  if (attrMatch && el.attrs[attrMatch[1]] !== attrMatch[2]) return false;
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

// `document` is a free variable inside the walker source (page-context
// code); pass the fake as a named param to `Function` so it resolves
// without touching global state.
function buildQueryDeep(): (doc: FakeDocument, selector: string) => FakeElement | null {
  return new Function('document', 'selector', `${QUERY_DEEP_SOURCE}\nreturn queryDeep(selector);`) as any;
}
function buildQueryAllDeep(): (doc: FakeDocument, selector: string) => FakeElement[] {
  return new Function('document', 'selector', `${QUERY_ALL_DEEP_SOURCE}\nreturn queryAllDeep(selector);`) as any;
}

// ── queryDeep / queryAllDeep behavior ────────────────────────────────────

describe('queryDeep()', () => {
  it('ordering regression lock: resolves the light-DOM match, not a shadow-nested match of the same selector', () => {
    const doc = new FakeDocument();
    const lightTarget = new FakeElement('div', { class: 'target' });
    const host = new FakeElement('my-host');
    doc.append(lightTarget, host);
    const shadowTarget = new FakeElement('div', { class: 'target' });
    host.attachShadow()!.append(shadowTarget);

    const queryDeep = buildQueryDeep();
    const result = queryDeep(doc, '.target');
    expect(result).toBe(lightTarget);
    expect(result).not.toBe(shadowTarget);
  });

  it('resolves a shadow-nested element that plain querySelector misses', () => {
    const doc = new FakeDocument();
    const host = new FakeElement('my-host');
    doc.append(host);
    const shadowOnly = new FakeElement('button', { class: 'only-in-shadow' });
    host.attachShadow()!.append(shadowOnly);

    expect(doc.querySelector('.only-in-shadow')).toBeNull();

    const queryDeep = buildQueryDeep();
    expect(queryDeep(doc, '.only-in-shadow')).toBe(shadowOnly);
  });

  it('resolves through nested shadow roots (depth >= 2)', () => {
    const doc = new FakeDocument();
    const outerHost = new FakeElement('outer-host');
    doc.append(outerHost);
    const outerShadow = outerHost.attachShadow()!;
    const innerHost = new FakeElement('inner-host');
    outerShadow.append(innerHost);
    const innerShadow = innerHost.attachShadow()!;
    const deepTarget = new FakeElement('span', { class: 'deep' });
    innerShadow.append(deepTarget);

    const queryDeep = buildQueryDeep();
    expect(queryDeep(doc, '.deep')).toBe(deepTarget);
  });

  it('returns null cleanly (no throw) when nothing matches anywhere', () => {
    const doc = new FakeDocument();
    const host = new FakeElement('my-host');
    doc.append(host);
    host.attachShadow();

    const queryDeep = buildQueryDeep();
    expect(() => queryDeep(doc, '.nope')).not.toThrow();
    expect(queryDeep(doc, '.nope')).toBeNull();
  });
});

describe('queryAllDeep()', () => {
  it('returns light matches before shadow matches, deduplicated', () => {
    const doc = new FakeDocument();
    const light1 = new FakeElement('div', { class: 'item' });
    const light2 = new FakeElement('div', { class: 'item' });
    const host = new FakeElement('my-host');
    doc.append(light1, light2, host);
    const shadow1 = new FakeElement('div', { class: 'item' });
    host.attachShadow()!.append(shadow1);

    const queryAllDeep = buildQueryAllDeep();
    const results = queryAllDeep(doc, '.item');
    expect(results).toEqual([light1, light2, shadow1]);
    expect(new Set(results).size).toBe(results.length);
  });

  it('returns an empty array (no throw) when nothing matches', () => {
    const doc = new FakeDocument();
    const queryAllDeep = buildQueryAllDeep();
    expect(() => queryAllDeep(doc, '.nope')).not.toThrow();
    expect(queryAllDeep(doc, '.nope')).toEqual([]);
  });
});

// ── source round-trip: syntactic validity + self-containment ────────────

describe('walker source round-trips', () => {
  it('QUERY_DEEP_SOURCE is syntactically valid and free of import/require and sibling references', () => {
    expect(() => new Function(`return (${QUERY_DEEP_SOURCE})`)()).not.toThrow();
    expect(QUERY_DEEP_SOURCE).not.toMatch(/\bimport\s/);
    expect(QUERY_DEEP_SOURCE).not.toMatch(/\brequire\(/);
    expect(QUERY_DEEP_SOURCE).not.toContain('queryAllDeep');

    const fn = new Function(`return (${QUERY_DEEP_SOURCE})`)() as Function;
    expect(fn.name).toBe('queryDeep');
    // round-trip through Function.prototype.toString(), as
    // chrome.scripting.executeScript({ func }) does on the extension side
    const roundTripped = fn.toString();
    expect(roundTripped).not.toMatch(/\bimport\s/);
    expect(roundTripped).not.toMatch(/\brequire\(/);
  });

  it('QUERY_ALL_DEEP_SOURCE is syntactically valid and free of import/require and sibling references', () => {
    expect(() => new Function(`return (${QUERY_ALL_DEEP_SOURCE})`)()).not.toThrow();
    expect(QUERY_ALL_DEEP_SOURCE).not.toMatch(/\bimport\s/);
    expect(QUERY_ALL_DEEP_SOURCE).not.toMatch(/\brequire\(/);
    expect(QUERY_ALL_DEEP_SOURCE).not.toContain('queryDeep(');

    const fn = new Function(`return (${QUERY_ALL_DEEP_SOURCE})`)() as Function;
    expect(fn.name).toBe('queryAllDeep');
    const roundTripped = fn.toString();
    expect(roundTripped).not.toMatch(/\bimport\s/);
    expect(roundTripped).not.toMatch(/\brequire\(/);
  });
});

// ── end-to-end through getSelectorExpression() ───────────────────────────
// Confirms the resolver actually wires the walker in: the expression it
// returns is spliced verbatim into a larger page-context expression
// (`const el = ${expr}`) by every call site, so it must itself be a single
// self-contained expression that resolves correctly against a real `document`.

describe('getSelectorExpression() end-to-end shadow piercing', () => {
  it('resolves a shadow-nested element through the returned expression', () => {
    const doc = new FakeDocument();
    const host = new FakeElement('my-host');
    doc.append(host);
    const shadowOnly = new FakeElement('button', { id: 'submit' });
    host.attachShadow()!.append(shadowOnly);

    (globalThis as any).document = doc;
    try {
      const expr = getSelectorExpression('#submit');
      const result = new Function(`return ${expr}`)();
      expect(result).toBe(shadowOnly);
    } finally {
      delete (globalThis as any).document;
    }
  });

  it('light DOM still wins over a same-selector shadow match end-to-end (non-breaking guarantee)', () => {
    const doc = new FakeDocument();
    const lightEl = new FakeElement('div', { class: 'x' });
    const host = new FakeElement('my-host');
    doc.append(lightEl, host);
    host.attachShadow()!.append(new FakeElement('div', { class: 'x' }));

    (globalThis as any).document = doc;
    try {
      const expr = getSelectorExpression('.x');
      const result = new Function(`return ${expr}`)();
      expect(result).toBe(lightEl);
    } finally {
      delete (globalThis as any).document;
    }
  });
});
