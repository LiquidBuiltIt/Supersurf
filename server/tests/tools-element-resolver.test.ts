import { describe, it, expect } from 'vitest';
import { getSelectorExpression } from '../src/tools/lib/element-resolver';

describe('getSelectorExpression()', () => {
  it('throws on empty selector', () => {
    expect(() => getSelectorExpression('')).toThrow('Selector is required');
  });

  it('passes plain selectors through unchanged', () => {
    expect(getSelectorExpression('#first_name')).toBe('document.querySelector("#first_name")');
    expect(getSelectorExpression('input[name="email"]')).toBe('document.querySelector("input[name=\\"email\\"]")');
    expect(getSelectorExpression('.foo .bar')).toBe('document.querySelector(".foo .bar")');
  });

  it('handles :has-text() selectors', () => {
    const out = getSelectorExpression('button:has-text("Submit")');
    expect(out).toContain('querySelectorAll("button")');
    expect(out).toContain('"Submit"');
  });

  // ── digit-leading ID rewrite (Ashby UUID fix) ──

  it('rewrites a bare digit-leading ID to [id="..."]', () => {
    expect(getSelectorExpression('#883a762f-8c9b-4686-b145-b2bfe30ce851')).toBe(
      'document.querySelector("[id=\\"883a762f-8c9b-4686-b145-b2bfe30ce851\\"]")',
    );
  });

  it('rewrites a tag-prefixed digit-leading ID', () => {
    expect(getSelectorExpression('input#883a762f-8c9b')).toBe(
      'document.querySelector("input[id=\\"883a762f-8c9b\\"]")',
    );
  });

  it('rewrites digit-leading IDs in descendant combinators', () => {
    expect(getSelectorExpression('.parent #883a76')).toBe(
      'document.querySelector(".parent [id=\\"883a76\\"]")',
    );
    expect(getSelectorExpression('div>p#883a76')).toBe(
      'document.querySelector("div>p[id=\\"883a76\\"]")',
    );
  });

  it('does NOT rewrite letter-leading IDs', () => {
    expect(getSelectorExpression('#abc123')).toBe('document.querySelector("#abc123")');
    expect(getSelectorExpression('#_systemfield_name')).toBe('document.querySelector("#_systemfield_name")');
  });

  it('preserves trailing class/attribute selectors after rewrite', () => {
    expect(getSelectorExpression('#883a76.active')).toBe(
      'document.querySelector("[id=\\"883a76\\"].active")',
    );
  });

  it('handles digit-leading IDs in :has-text() base', () => {
    const out = getSelectorExpression('#883a76:has-text("Apply")');
    expect(out).toContain('querySelectorAll("[id=\\"883a76\\"]")');
    expect(out).toContain('"Apply"');
  });
});
