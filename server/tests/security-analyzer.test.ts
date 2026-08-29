/**
 * Unit tests for the rule-driven analyzer. These use throwaway rule sets on
 * purpose — the analyzer must know nothing about WHICH rules it is running.
 * Parity with the real page blocklist is covered by
 * tests/security-blocklist-parity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { analyzeWithRules, type RuleSet } from '../src/security/analyzer';

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

  it('walks all six supported node types', () => {
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
