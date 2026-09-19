import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSelectorExpression,
  getAllSelectorExpression,
  findAlternativeSelectors,
} from '../src/tools/lib/element-resolver';

describe('getSelectorExpression()', () => {
  it('throws on empty selector', () => {
    expect(() => getSelectorExpression('')).toThrow('Selector is required');
  });

  it('passes plain selectors through as a queryDeep() call, quoted correctly', () => {
    expect(getSelectorExpression('#first_name')).toContain('queryDeep("#first_name")');
    expect(getSelectorExpression('input[name="email"]')).toContain(
      'queryDeep("input[name=\\"email\\"]")',
    );
    expect(getSelectorExpression('.foo .bar')).toContain('queryDeep(".foo .bar")');
  });

  it('handles :has-text() selectors via queryAllDeep', () => {
    const out = getSelectorExpression('button:has-text("Submit")');
    expect(out).toContain('queryAllDeep("button")');
    expect(out).toContain('"Submit"');
  });

  // ── digit-leading ID rewrite (Ashby UUID fix) ──

  it('rewrites a bare digit-leading ID to [id="..."]', () => {
    expect(getSelectorExpression('#883a762f-8c9b-4686-b145-b2bfe30ce851')).toContain(
      'queryDeep("[id=\\"883a762f-8c9b-4686-b145-b2bfe30ce851\\"]")',
    );
  });

  it('rewrites a tag-prefixed digit-leading ID', () => {
    expect(getSelectorExpression('input#883a762f-8c9b')).toContain(
      'queryDeep("input[id=\\"883a762f-8c9b\\"]")',
    );
  });

  it('rewrites digit-leading IDs in descendant combinators', () => {
    expect(getSelectorExpression('.parent #883a76')).toContain(
      'queryDeep(".parent [id=\\"883a76\\"]")',
    );
    expect(getSelectorExpression('div>p#883a76')).toContain(
      'queryDeep("div>p[id=\\"883a76\\"]")',
    );
  });

  it('does NOT rewrite letter-leading IDs', () => {
    expect(getSelectorExpression('#abc123')).toContain('queryDeep("#abc123")');
    expect(getSelectorExpression('#_systemfield_name')).toContain('queryDeep("#_systemfield_name")');
  });

  it('preserves trailing class/attribute selectors after rewrite', () => {
    expect(getSelectorExpression('#883a76.active')).toContain(
      'queryDeep("[id=\\"883a76\\"].active")',
    );
  });

  it('handles digit-leading IDs in :has-text() base', () => {
    const out = getSelectorExpression('#883a76:has-text("Apply")');
    expect(out).toContain('queryAllDeep("[id=\\"883a76\\"]")');
    expect(out).toContain('"Apply"');
  });

  // ── self-containment / shape ──

  it('returns a single expression (an IIFE), not a bare statement', () => {
    const out = getSelectorExpression('#x');
    expect(out.trim().startsWith('(() => {')).toBe(true);
    expect(out.trim().endsWith('})()')).toBe(true);
  });

  it('inlines the walker function source rather than referencing an import', () => {
    const out = getSelectorExpression('#x');
    expect(out).toContain('function queryDeep(selector)');
    expect(out).not.toContain('require(');
    expect(out).not.toMatch(/^\s*import /m);
  });
});

describe('getAllSelectorExpression()', () => {
  it('builds a queryAllDeep expression carrying its own walker', () => {
    const expr = getAllSelectorExpression('.WorkflowJob');
    expect(expr).toContain('function queryAllDeep');
    expect(expr).toContain('queryAllDeep(".WorkflowJob")');
  });

  it('rewrites digit-leading ids the same way the singular form does', () => {
    expect(getAllSelectorExpression('#883a76')).toContain('[id=');
    expect(getAllSelectorExpression('#883a76')).toContain('883a76');
  });

  it('filters by text for the :has-text() form instead of returning the first hit', () => {
    const expr = getAllSelectorExpression('li:has-text("Ship it")');
    expect(expr).toContain('queryAllDeep("li")');
    expect(expr).toContain('.filter(');
    expect(expr).toContain('Ship it');
  });

  it('rejects an empty selector', () => {
    expect(() => getAllSelectorExpression('')).toThrow('Selector is required');
  });
});

describe('findAlternativeSelectors() — emitted page code', () => {
  /** Run the function with a spy evaluator and hand back the page source it built. */
  async function capture(selector: string): Promise<string> {
    let seen = '';
    const evalFn = async (expression: string) => {
      seen = expression;
      return [];
    };
    await findAlternativeSelectors(evalFn, selector);
    return seen;
  }

  it('does not emit the double-backslash class-split typo', async () => {
    const code = await capture('button:has-text("Got it")');
    // '\\\\s+' in a TS string literal is the two characters \ \ followed by s+ —
    // exactly the broken emission this test exists to lock out.
    expect(code).not.toContain('\\\\s+');
  });

  it('emits a class-splitting regex that actually splits on whitespace', async () => {
    const code = await capture('button:has-text("Got it")');
    const m = code.match(/\.split\((\/[^/]+\/)\)/);
    expect(m).not.toBeNull();
    // Build the regex the page would build, and prove it splits whitespace.
    const re: RegExp = new Function(`return ${m![1]}`)();
    expect('alpha  beta\tgamma'.split(re)).toEqual(['alpha', 'beta', 'gamma']);
  });
});

import {
  rankAlternatives,
  renderAlternatives,
  type AltCandidate,
} from '../src/tools/lib/element-resolver';

const c = (over: Partial<AltCandidate>): AltCandidate => ({
  selector: 'div', visible: true, tag: 'div',
  x: 0, y: 0, width: 10, height: 10, score: 0, ...over,
});

describe('rankAlternatives()', () => {
  it('puts visible candidates first, highest score first', () => {
    const out = rankAlternatives([
      c({ selector: 'a', visible: true, score: 1 }),
      c({ selector: 'b', visible: true, score: 3 }),
      c({ selector: 'd', visible: false, score: 9 }),
      c({ selector: 'e', visible: true, score: 2 }),
    ]);
    expect(out.map((x) => x.selector)).toEqual(['b', 'e', 'a']);
  });

  it('omits hidden candidates entirely when three or more are visible', () => {
    const out = rankAlternatives([
      c({ selector: 'a', visible: true }),
      c({ selector: 'b', visible: true }),
      c({ selector: 'd', visible: true }),
      c({ selector: 'hid', visible: false }),
    ]);
    expect(out.some((x) => !x.visible)).toBe(false);
  });

  it('keeps at most two hidden candidates when fewer than three are visible', () => {
    const out = rankAlternatives([
      c({ selector: 'a', visible: true }),
      c({ selector: 'h1', visible: false }),
      c({ selector: 'h2', visible: false }),
      c({ selector: 'h3', visible: false }),
    ]);
    expect(out.filter((x) => !x.visible)).toHaveLength(2);
  });

  it('caps the whole list at five', () => {
    const out = rankAlternatives(
      Array.from({ length: 12 }, (_, i) => c({ selector: `s${i}`, visible: true })),
    );
    expect(out).toHaveLength(5);
  });
});

describe('renderAlternatives()', () => {
  it('renders the approved two-line shape', () => {
    const out = renderAlternatives([
      c({
        selector: 'span.docs-promo-action-container.promo-dismiss-link',
        tag: 'span', text: 'Got it', visible: true,
        width: 63, height: 40, x: 1112, y: 664,
      }),
    ]);
    expect(out).toBe(
      'Did you mean?\n' +
      '  1. "Got it" · span · visible · 63×40 @ (1112,664)\n' +
      '     span.docs-promo-action-container.promo-dismiss-link',
    );
  });

  it('marks a hidden candidate as hidden', () => {
    const out = renderAlternatives([c({ selector: 'div.x', visible: false, width: 0, height: 0 })]);
    expect(out).toContain('· hidden ·');
    expect(out).toContain('0×0');
  });

  it('omits the text segment when the candidate has none', () => {
    const out = renderAlternatives([c({ selector: 'div.x', tag: 'div' })]);
    expect(out).toContain('  1. div · visible ·');
    expect(out).not.toContain('""');
  });

  it('returns an empty string for an empty list', () => {
    expect(renderAlternatives([])).toBe('');
  });
});

describe('findAlternativeSelectors() — plain CSS selectors', () => {
  async function capture(selector: string): Promise<string> {
    let seen = '';
    await findAlternativeSelectors(async (expression: string) => {
      seen = expression;
      return [];
    }, selector);
    return seen;
  }

  it('builds a candidate query for a selector with no :has-text()', async () => {
    const code = await capture('.docs-promo-action-container');
    expect(code).not.toBe('');
    expect(code).toContain('"promo"');
    expect(code).toContain('"action"');
    expect(code).toContain('"container"');
  });

  it('still falls back to interactive elements when the selector yields no tokens', async () => {
    const code = await capture('tr.zA');
    expect(code).toContain('a[href], button, input, select, textarea, [role="button"]');
  });

  it('keeps the text-match path for :has-text() selectors', async () => {
    const code = await capture('div:has-text("Got it")');
    expect(code).toContain('"Got it"');
  });
});

import { resolveEphemeral, dropSession } from '../src/experimental/fingerprinting/ephemeral-handles';

describe('findAlternativeSelectors() — ephemeral handles', () => {
  const page = [
    { selector: 'span.a.b', tag: 'span', visible: true, text: 'Got it',
      label: '', width: 63, height: 40, x: 1112, y: 664, score: 2 },
    { selector: 'div.c', tag: 'div', visible: true, text: '',
      label: '', width: 10, height: 10, x: 1, y: 2, score: 1 },
  ];

  beforeEach(() => dropSession('sess-1'));

  it('mints a handle for a candidate with text and none for one without', async () => {
    const out = await findAlternativeSelectors(async () => page, 'div.missing', 'sess-1');
    expect(out[0].handle).toBe('got_it');
    expect(out[1].handle).toBeUndefined();
    expect(resolveEphemeral('got_it')).toBe('span.a.b');
  });

  it('renders the handle on the candidate line and omits it where absent', async () => {
    const out = await findAlternativeSelectors(async () => page, 'div.missing', 'sess-1');
    const text = renderAlternatives(out);
    expect(text).toContain('1. @got_it · "Got it" · span · visible · 63×40 @ (1112,664)');
    expect(text).toContain('2. div · visible ·');
  });

  it('mints nothing when there is no session id', async () => {
    const out = await findAlternativeSelectors(async () => page, 'div.missing');
    expect(out[0].handle).toBeUndefined();
  });

  it('never derives a name from class tokens', async () => {
    const hashed = [{
      selector: 'div.SidebarAbout-module__description__xTkIP', tag: 'div',
      visible: true, text: '', label: '', width: 5, height: 5, x: 0, y: 0, score: 3,
    }];
    const out = await findAlternativeSelectors(async () => hashed, 'div.missing', 'sess-1');
    expect(out[0].handle).toBeUndefined();
  });
});
