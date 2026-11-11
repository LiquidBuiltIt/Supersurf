/**
 * Unit tests for the rule-driven analyzer. These use throwaway rule sets on
 * purpose — the analyzer must know nothing about WHICH rules it is running.
 * Parity with the real page blocklist is covered by
 * tests/security-blocklist-parity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { analyzeWithRules, type RuleSet } from '../src/security/analyzer';
import { nodeRules } from '../src/security/rules/node';

const banFoo: RuleSet = {
  patterns: [{
    nodeType: 'CallExpression',
    matcher: (node: any) => node.callee?.type === 'Identifier' && node.callee.name === 'foo',
    reason: 'foo() is banned',
  }],
};

describe('analyzeWithRules', () => {
  it('returns safe for code that matches no pattern', () => {
    expect(analyzeWithRules('bar()', banFoo)).toEqual({ safe: true });
  });

  it('returns the reason of the matched pattern', () => {
    expect(analyzeWithRules('foo()', banFoo)).toEqual({ safe: false, reason: 'foo() is banned' });
  });

  it('returns safe for empty or whitespace-only code', () => {
    expect(analyzeWithRules('', banFoo)).toEqual({ safe: true });
    expect(analyzeWithRules('  \n\t ', banFoo)).toEqual({ safe: true });
  });

  it('returns safe for unparseable code — callers surface their own syntax errors', () => {
    expect(analyzeWithRules('foo( ( (', banFoo)).toEqual({ safe: true });
  });

  it('returns safe for an empty rule set', () => {
    expect(analyzeWithRules('foo(); eval("x")', { patterns: [] })).toEqual({ safe: true });
  });

  it('stops at the first violation', () => {
    const twoRules: RuleSet = {
      patterns: [
        { nodeType: 'CallExpression', matcher: (n: any) => n.callee?.name === 'foo', reason: 'first' },
        { nodeType: 'CallExpression', matcher: () => true, reason: 'second' },
      ],
    };
    expect(analyzeWithRules('foo()', twoRules).reason).toBe('first');
  });

  it('passes the ancestor chain to the matcher', () => {
    const seen: string[] = [];
    analyzeWithRules('a.b.c', {
      patterns: [{
        nodeType: 'MemberExpression',
        matcher: (_n: any, ancestors: any[]) => { seen.push(ancestors.map(a => a.type).join('>')); return false; },
        reason: 'never',
      }],
    });
    expect(seen.some(s => s.startsWith('Program>ExpressionStatement>MemberExpression'))).toBe(true);
  });

  it('walks all six directly-dispatched node types (ObjectPattern re-dispatches through MemberExpression patterns instead of its own — covered separately below)', () => {
    const hits: string[] = [];
    const spy = (nodeType: string) => ({
      nodeType,
      matcher: () => { hits.push(nodeType); return false; },
      reason: 'never',
    });
    analyzeWithRules(
      "f(); a.b; new C(); import('x'); tag`t`; 'lit';",
      {
        patterns: [
          spy('CallExpression'), spy('MemberExpression'), spy('NewExpression'),
          spy('ImportExpression'), spy('TaggedTemplateExpression'), spy('Literal'),
        ],
      },
    );
    expect(new Set(hits)).toEqual(new Set([
      'CallExpression', 'MemberExpression', 'NewExpression',
      'ImportExpression', 'TaggedTemplateExpression', 'Literal',
    ]));
  });

  it('re-dispatches a destructured property key through MemberExpression patterns', () => {
    const seen: any[] = [];
    const banBar: RuleSet = {
      patterns: [{
        nodeType: 'MemberExpression',
        matcher: (node: any) => { seen.push(node); return node.property?.name === 'bar'; },
        reason: 'bar is banned',
      }],
    };
    const result = analyzeWithRules('const { bar: alias } = obj;', banBar);
    expect(result).toEqual({ safe: false, reason: 'bar is banned' });
    // The synthetic node has no real `.object` — patterns that only inspect
    // `.property` (like this one) still work; patterns keyed on `.object`
    // correctly find nothing to match.
    expect(seen[0].object).toBeNull();
  });

  it('parses top-level return and await by default', () => {
    expect(analyzeWithRules('return await x;', banFoo)).toEqual({ safe: true });
  });

  it('merges parseOptions over the defaults', () => {
    // sourceType 'script' makes an export illegal -> unparseable -> safe.
    const scriptRules: RuleSet = { patterns: banFoo.patterns, parseOptions: { sourceType: 'script' } };
    expect(analyzeWithRules('export const meta = {}; foo();', scriptRules)).toEqual({ safe: true });
    // The default (module) parses it, so the pattern fires.
    expect(analyzeWithRules('export const meta = {}; foo();', banFoo).safe).toBe(false);
  });
});

/**
 * Regression: WALKED_NODE_TYPES only ever covered CallExpression,
 * MemberExpression, NewExpression, ImportExpression, TaggedTemplateExpression
 * and Literal. Destructuring (`const { constructor: C } = x`) and a
 * template-literal computed key (`x[`constructor`]`) never produce a
 * MemberExpression node, so the existing `__proto__` / `constructor` rule in
 * the real Node blocklist (rules/node.ts) — which only inspects
 * `.property` — silently never fired for these forms. Run against the real
 * `nodeRules`, not a throwaway set, because the whole point is that the
 * production blocklist was blind to these, not a hypothetical one.
 */
describe('analyzeWithRules — destructuring and computed-template evasion (regression)', () => {
  it('blocks destructured constructor: const { constructor: C } = supersurf.click;', () => {
    const result = analyzeWithRules('const { constructor: C } = supersurf.click;', nodeRules);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Prototype chain walking');
  });

  it('blocks destructured __proto__: const { __proto__: p } = supersurf;', () => {
    const result = analyzeWithRules('const { __proto__: p } = supersurf;', nodeRules);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Prototype chain walking');
  });

  it('blocks a template-literal computed key with no interpolation: supersurf.click[`constructor`]', () => {
    const result = analyzeWithRules('supersurf.click[`constructor`];', nodeRules);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Prototype chain walking');
  });

  it('still blocks the plain member form (sanity check, unaffected by the fix)', () => {
    expect(analyzeWithRules('supersurf.click.constructor;', nodeRules).safe).toBe(false);
  });

  it('blocks the __lookup*__ accessors, member and destructured', () => {
    // `({}).__lookupGetter__('__proto__')` returns Object.prototype's own
    // getter for `__proto__`, which yields a prototype when called — the same
    // walk the two obvious names cover, one indirection further out.
    expect(analyzeWithRules("({}).__lookupGetter__('__proto__');", nodeRules).safe).toBe(false);
    expect(analyzeWithRules('const { __lookupSetter__: s } = o;', nodeRules).safe).toBe(false);
  });

  it('does NOT flag ordinary destructuring of non-blocked names', () => {
    expect(analyzeWithRules('const { text, count } = params;', nodeRules)).toEqual({ safe: true });
  });

  it('does NOT flag nested destructuring of non-blocked names', () => {
    expect(analyzeWithRules('const { a: { b, c } } = params;', nodeRules)).toEqual({ safe: true });
  });

  it('blocks a blocked name reached through nested/renamed destructuring: const { a: { constructor: C2 } } = obj;', () => {
    const result = analyzeWithRules('const { a: { constructor: C2 } } = obj;', nodeRules);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Prototype chain walking');
  });
});
