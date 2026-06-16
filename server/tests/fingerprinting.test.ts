import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getRecord, putRecord, loadDomain, setBaseDirForTests } from '../src/experimental/fingerprinting/store';
import type { FingerprintRecord } from '../src/experimental/fingerprinting/types';
import { captureExpr, scoreExpr } from '../src/experimental/fingerprinting/page-scripts';
import { domainOf, routeOf, passesGate, THRESHOLD, MARGIN, captureOnResolve } from '../src/experimental/fingerprinting/index';

const TMP = path.join(process.cwd(), '.tmp-fp-store');
setBaseDirForTests(TMP);
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

function rec(selector: string): FingerprintRecord {
  return {
    selector, role: 'button', name: 'Sign in', text: 'Sign in', tag: 'button', type: null,
    attrs: {}, classList: ['x'], htmlId: '', ordinal: 0, cx: 10, cy: 20,
    neighborText: '', landmark: 'banner:', capturedAt: 1, lastSeenAt: 1, hits: 1,
  };
}

describe('fingerprint store', () => {
  it('returns undefined for an unknown record', () => {
    expect(getRecord('ex.com', '/', '#nope')).toBeUndefined();
  });

  it('persists and reloads a record across calls (disk round-trip)', () => {
    putRecord('ex.com', '/', '#go', rec('#go'));
    const got = getRecord('ex.com', '/', '#go');
    expect(got?.name).toBe('Sign in');
    // fresh read from disk, not memory
    const onDisk = loadDomain('ex.com');
    expect(onDisk.routes['/']['#go'].selector).toBe('#go');
  });

  it('keeps multiple routes and selectors separate', () => {
    putRecord('ex.com', '/', '#a', rec('#a'));
    putRecord('ex.com', '/login', '#b', rec('#b'));
    expect(getRecord('ex.com', '/', '#b')).toBeUndefined();
    expect(getRecord('ex.com', '/login', '#b')?.selector).toBe('#b');
  });
});

describe('page-scripts builders', () => {
  it('captureExpr embeds the selector and is a self-contained IIFE', () => {
    const e = captureExpr('a.btn');
    expect(e).toContain('a.btn');
    expect(e.trim().startsWith('(function')).toBe(true);
    expect(e.trim().endsWith(')()')).toBe(true);
  });

  it('scoreExpr embeds the target JSON and returns an IIFE', () => {
    const e = scoreExpr('{"role":"button","name":"Go"}');
    expect(e).toContain('"name":"Go"');
    expect(e.trim().startsWith('(function')).toBe(true);
    expect(e.trim().endsWith(')()')).toBe(true);
  });

  it('captureExpr handles :has-text via getSelectorExpression (not raw querySelector of the invalid selector)', () => {
    const e = captureExpr('button:has-text("Submit")');
    // The :has-text text is preserved in the resolution logic...
    expect(e).toContain('Submit');
    // ...but it must NOT be passed to a raw querySelector (which would throw — that was the live bug).
    expect(e).not.toContain('querySelector("button:has-text');
    expect(e).not.toContain("querySelector('button:has-text");
    // getSelectorExpression rewrites :has-text into a textContent scan.
    expect(e).toContain('textContent');
  });

  it('captureExpr rewrites digit-leading-id selectors to attribute form', () => {
    const e = captureExpr('#883a76-abc');
    // raw `#883a76-abc` is invalid CSS; getSelectorExpression rewrites to [id="..."] form
    // (rendered with escaped quotes inside the querySelector string).
    expect(e).toContain('[id=');
    expect(e).toContain('883a76-abc');
    expect(e).not.toContain('querySelector("#883a76'); // never the raw invalid form
  });
});

describe('url keying', () => {
  it('strips www and returns hostname', () => {
    expect(domainOf('https://www.youtube.com/watch?v=1')).toBe('youtube.com');
  });
  it('returns pathname as route, default /', () => {
    expect(routeOf('https://x.com/a/b?q=1')).toBe('/a/b');
    expect(routeOf('https://x.com')).toBe('/');
  });
  it('falls back safely on garbage urls', () => {
    expect(domainOf('not a url')).toBe('unknown');
    expect(routeOf('not a url')).toBe('/');
  });
  it('keys file:// urls under a dedicated "file" domain with the path as route', () => {
    expect(domainOf('file:///home/x/heal-test.html')).toBe('file');
    expect(routeOf('file:///home/x/heal-test.html')).toBe('/home/x/heal-test.html');
  });
});

describe('capture guard', () => {
  const fakeEval = async () => JSON.stringify({
    role: 'button', name: 'X', text: '', tag: 'button', type: null,
    attrs: {}, classList: [], htmlId: '', ordinal: 0, cx: 1, cy: 1,
    neighborText: '', landmark: '',
  });

  it('does NOT persist when the domain is unknown (no url)', async () => {
    await captureOnResolve(fakeEval, '', '#x');
    expect(getRecord('unknown', '/', '#x')).toBeUndefined();
  });

  it('DOES persist for a real domain (control)', async () => {
    await captureOnResolve(fakeEval, 'https://ex.com/p', '#z');
    expect(getRecord('ex.com', '/p', '#z')?.selector).toBe('#z');
  });
});

describe('threshold gate', () => {
  it('passes only when score>=THRESHOLD AND margin>=MARGIN', () => {
    expect(passesGate({ cx: 1, cy: 1, score: THRESHOLD, margin: MARGIN })).toBe(true);
    expect(passesGate({ cx: 1, cy: 1, score: THRESHOLD - 0.01, margin: 0.9 })).toBe(false);
    expect(passesGate({ cx: 1, cy: 1, score: 0.99, margin: MARGIN - 0.01 })).toBe(false);
  });
});
