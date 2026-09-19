import { describe, it, expect } from 'vitest';
import { QUALIFY_SOURCE } from '../src/tools/lib/selector-qualify';

/**
 * Run one helper out of QUALIFY_SOURCE in Node. The source is page code, not
 * module code, so it is executed via `new Function` with stubs for the three
 * browser globals it touches. Only the pure string helpers are exercised here —
 * element IDENTITY needs a real DOM and is proved by `npm run smoke.hints`.
 */
function runHelper(call: string, globals: Record<string, any> = {}) {
  const names = ['document', 'CSS', ...Object.keys(globals)];
  const values = [
    globals.document ?? { querySelector: () => null, querySelectorAll: () => [], body: {} },
    globals.CSS ?? { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c: string) => '\\' + c) },
    ...Object.values(globals),
  ];
  const fn = new Function(...names, `${QUALIFY_SOURCE}\nreturn ${call};`);
  return fn(...values);
}

describe('QUALIFY_SOURCE — page code validity', () => {
  it('parses as JavaScript and exposes the ladder entry point', () => {
    expect(runHelper('typeof qualify')).toBe('function');
    expect(runHelper('typeof ssResolve')).toBe('function');
    expect(runHelper('typeof ssSafe')).toBe('function');
    expect(runHelper('typeof ssDescendantTexts')).toBe('function');
    expect(runHelper('typeof ssPath')).toBe('function');
  });
});

describe('ssSafe()', () => {
  it('collapses whitespace runs to a single space', () => {
    expect(runHelper(`ssSafe('  Close\\n   the dialog  ')`)).toBe('Close the dialog');
  });

  it('truncates to 50 characters WITHOUT appending an ellipsis', () => {
    const long = 'Android 17 is the first release since 3.x to ship a new runtime';
    const out = runHelper(`ssSafe(${JSON.stringify(long)})`);
    expect(out).toHaveLength(50);
    expect(out).toBe(long.slice(0, 50));
    expect(out.endsWith('...')).toBe(false);
  });

  it('rejects text containing a double quote — the :has-text grammar cannot escape it', () => {
    expect(runHelper(`ssSafe('He said "no"')`)).toBe('');
  });

  it('rejects text containing a single quote', () => {
    expect(runHelper(`ssSafe("it's fine")`)).toBe('');
  });

  it('rejects text containing a backslash', () => {
    expect(runHelper(String.raw`ssSafe('C:\\path')`)).toBe('');
  });

  it('returns empty for nullish input rather than the string "null"', () => {
    expect(runHelper('ssSafe(null)')).toBe('');
    expect(runHelper('ssSafe(undefined)')).toBe('');
  });
});

describe('ssResolve() — mirrors getSelectorExpression semantics', () => {
  it('uses plain querySelector for a selector with no :has-text', () => {
    const target = { tag: 'a' };
    const document = {
      querySelector: (s: string) => (s === 'a.x' ? target : null),
      querySelectorAll: () => [],
      body: {},
    };
    expect(runHelper(`ssResolve('a.x')`, { document })).toBe(target);
  });

  it('matches :has-text on SUBTREE textContent, first match in document order', () => {
    const logo = { textContent: '' };
    const newLink = { textContent: 'new' };
    const document = {
      querySelector: () => null,
      querySelectorAll: (s: string) => (s === 'a' ? [logo, newLink] : []),
      body: {},
    };
    expect(runHelper(`ssResolve('a:has-text("new")')`, { document })).toBe(newLink);
  });

  it('returns null instead of throwing on an invalid selector', () => {
    const document = {
      querySelector: () => { throw new Error('SyntaxError'); },
      querySelectorAll: () => { throw new Error('SyntaxError'); },
      body: {},
    };
    expect(runHelper(`ssResolve('a[[[')`, { document })).toBeNull();
  });
});

describe('qualify() — rung selection', () => {
  const stubDoc = (byBase: any[], unique: Record<string, any> = {}) => ({
    querySelector: (s: string) => unique[s] ?? null,
    querySelectorAll: (s: string) => (s.indexOf(':has-text') === -1 ? byBase : []),
    body: {},
  });

  it('rung 0: returns the base unchanged when the base already resolves to el', () => {
    const el = { textContent: 'x', childNodes: [], children: [], getAttribute: () => null };
    const document = stubDoc([], { 'a#go': el });
    const out = runHelper(`qualify(el, 'a#go')`, { document, el });
    expect(out).toEqual({ selector: 'a#go', source: 'unique' });
  });

  it('rung 5: returns the base with a null source when nothing verifies', () => {
    const el = { textContent: '', childNodes: [], children: [], getAttribute: () => null, previousElementSibling: null, parentElement: null, tagName: 'LI', nodeType: 1 };
    const other = { textContent: '' };
    const document = stubDoc([other, el], {});
    const out = runHelper(`qualify(el, 'li')`, { document, el });
    expect(out.source).toBeNull();
    expect(out.selector).toBe('li');
  });
});
