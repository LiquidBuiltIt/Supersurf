import { describe, it, expect } from 'vitest';
import { scoreExpr } from '../src/experimental/fingerprinting/page-scripts';
import type { ScoreHit } from '../src/experimental/fingerprinting/types';

/** Minimal stand-in for a DOM element — only the surface page-scripts.ts HELPERS touch. */
function fakeEl(spec: {
  tag: string; id?: string; text?: string;
  attrs?: Record<string, string>; cls?: string; x?: number; y?: number;
}) {
  const attrs: Record<string, string> = { ...(spec.attrs ?? {}) };
  if (spec.cls) attrs['class'] = spec.cls;
  return {
    tagName: spec.tag.toUpperCase(),
    id: spec.id ?? '',
    parentElement: null,
    childNodes: spec.text ? [{ nodeType: 3, textContent: spec.text }] : [],
    textContent: spec.text ?? '',
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    attributes: Object.keys(attrs).map(name => ({ name, value: attrs[name] })),
    querySelectorAll: () => [],
    matches: () => false,
    getBoundingClientRect: () => ({
      left: spec.x ?? 0, top: spec.y ?? 0, width: 10, height: 10,
    }),
  };
}

/** Run a generated in-page expression against a fake `document`. */
function runExpr(expr: string, nodes: unknown[]): ScoreHit | null {
  const doc = { querySelectorAll: () => nodes };
  const raw = new Function('document', `return ${expr};`)(doc);
  return typeof raw === 'string' ? (JSON.parse(raw) as ScoreHit) : null;
}

const TARGET = {
  role: 'button', name: 'Post', text: 'Post', tag: 'button', type: null,
  attrs: { 'data-testid': 'tweetButton' }, classList: ['r-1', 'r-2'],
  htmlId: 'tweet-btn', ordinal: 0, cx: 105, cy: 205,
  neighborText: '', landmark: '',
};

describe('scoreExpr returns the winning candidate identity', () => {
  const nodes = [
    fakeEl({
      tag: 'button', id: 'tweet-btn', text: 'Post',
      attrs: { 'data-testid': 'tweetButton' }, cls: 'r-1 r-2', x: 100, y: 200,
    }),
    fakeEl({ tag: 'a', text: 'Home', x: 10, y: 10 }),
  ];

  it('picks the matching candidate with a clean score and margin', () => {
    const hit = runExpr(scoreExpr(JSON.stringify(TARGET)), nodes)!;
    expect(hit.score).toBeGreaterThan(0.9);
    expect(hit.margin).toBeGreaterThan(0.5);
    expect(hit.cx).toBe(105);
    expect(hit.cy).toBe(205);
  });

  it('carries the winner htmlId, tag, attrs and classList (not just coordinates)', () => {
    const hit = runExpr(scoreExpr(JSON.stringify(TARGET)), nodes)!;
    expect(hit.htmlId).toBe('tweet-btn');
    expect(hit.tag).toBe('button');
    expect(hit.attrs['data-testid']).toBe('tweetButton');
    expect(hit.classList).toEqual(['r-1', 'r-2']);
    expect(hit.role).toBe('button');
    expect(hit.name).toBe('Post');
    expect(hit.type).toBeNull();
    expect(hit.ordinal).toBe(0);
  });

  it('returns null when there are no candidates at all', () => {
    expect(runExpr(scoreExpr(JSON.stringify(TARGET)), [])).toBeNull();
  });
});
