import { describe, it, expect } from 'vitest';
import { getSelectorExpression, getAllSelectorExpression } from '../src/tools/lib/element-resolver';

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
