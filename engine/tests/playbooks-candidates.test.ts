import { describe, it, expect, vi } from 'vitest';
import {
  selectorTokens,
  candidateExpression,
  captureCandidates,
  MAX_CANDIDATES,
} from '../src/playbooks/candidates';

describe('selectorTokens()', () => {
  it('splits a hyphenated class into matchable fragments', () => {
    expect(selectorTokens('.Layout-sidebar')).toEqual(expect.arrayContaining(['layout', 'sidebar']));
  });

  it('splits camelCase so a renamed prefix still matches', () => {
    expect(selectorTokens('.SidebarAbout')).toEqual(expect.arrayContaining(['sidebar', 'about']));
  });

  it('drops fragments too short or too generic to discriminate', () => {
    const tokens = selectorTokens('div.job > span');
    expect(tokens).not.toContain('div');
    expect(tokens).not.toContain('span');
    expect(tokens).not.toContain('job'); // 3 chars — below the floor
  });

  it('returns nothing for an opaque selector, so the interactive fallback takes over', () => {
    expect(selectorTokens('tr.zA')).toEqual([]);
  });

  it('reads tokens out of attribute selectors too', () => {
    expect(selectorTokens('[data-testid="commit-header"]')).toEqual(
      expect.arrayContaining(['testid', 'commit', 'header']),
    );
  });
});

describe('candidateExpression()', () => {
  it('embeds the tokens and the limit', () => {
    const expr = candidateExpression(['sidebar'], 5);
    expect(expr).toContain('"sidebar"');
    expect(expr).toContain('5');
  });

  it('still builds an interactive-only sweep when there are no tokens', () => {
    const expr = candidateExpression([], 5);
    expect(expr).toContain('a[href]');
    expect(expr).toContain('button');
  });
});

describe('captureCandidates()', () => {
  function backendReturning(result: any) {
    return { callTool: vi.fn().mockResolvedValue(result) };
  }

  it('asks the page once, via browser_evaluate, with a non-empty purpose', async () => {
    const backend = backendReturning({
      url: 'https://github.com/o/r',
      title: 'o/r',
      candidates: [{ selector: 'div.SidebarAbout-module__description__xTkIP' }],
    });

    const out = await captureCandidates(backend, '.Layout-sidebar');

    expect(backend.callTool).toHaveBeenCalledTimes(1);
    const [tool, args, options] = backend.callTool.mock.calls[0];
    expect(tool).toBe('browser_evaluate');
    expect(String(args.purpose)).not.toBe('');
    expect(options).toEqual({ rawResult: true });
    expect(out!.url).toBe('https://github.com/o/r');
    expect(out!.candidates[0].selector).toContain('SidebarAbout');
  });

  it('caps the returned list at MAX_CANDIDATES', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ selector: `div.c${i}` }));
    const out = await captureCandidates(backendReturning({ candidates: many }), '.thing-name');
    expect(out!.candidates.length).toBe(MAX_CANDIDATES);
  });

  it('returns undefined rather than throwing when the eval is blocked', async () => {
    const backend = { callTool: vi.fn().mockResolvedValue({ success: false, error: 'Code blocked by `secure_eval`.' }) };
    await expect(captureCandidates(backend, '.x')).resolves.toBeUndefined();
  });

  it('returns undefined rather than throwing when the tool call throws', async () => {
    const backend = { callTool: vi.fn().mockRejectedValue(new Error('Target crashed')) };
    await expect(captureCandidates(backend, '.x')).resolves.toBeUndefined();
  });

  // The "never throws" contract, held at the ONE input the caller does not
  // validate. The runner casts the selector to `string` at compile time only,
  // and a throw out of here escapes `runPlaybook` before tab teardown — the run
  // leaks its tab.
  it('returns undefined rather than throwing on a non-string selector', async () => {
    const backend = { callTool: vi.fn() };
    await expect(captureCandidates(backend, undefined as any)).resolves.toBeUndefined();
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('caps a page-controlled url and title so they cannot crowd out the candidates', async () => {
    const out = await captureCandidates(
      backendReturning({
        url: `data:text/html,${'A'.repeat(20000)}`,
        title: 'T'.repeat(5000),
        candidates: [{ selector: 'div.a' }],
      }),
      '.thing-name',
    );
    expect(out!.url!.length).toBeLessThanOrEqual(200);
    expect(out!.title!.length).toBeLessThanOrEqual(120);
    expect(out!.candidates.length).toBe(1);
  });

  it('keeps the whole payload comfortably under the 4 KB evidence cap', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      selector: `div.some-quite-long-class-name-number-${i}`,
      text: 'x'.repeat(200),
    }));
    const out = await captureCandidates(
      backendReturning({ url: 'https://example.com', title: 'T', candidates: many }),
      '.thing-name',
    );
    expect(JSON.stringify(out).length).toBeLessThan(4000);
  });
});
