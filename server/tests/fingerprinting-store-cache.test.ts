import { describe, it, expect, afterEach, vi } from 'vitest';

// NOTE: `vi.spyOn(fs, 'readFileSync')` does not reliably intercept calls made by
// store.ts's own `import * as fs from 'node:fs'` in this Vitest/Node setup — the
// namespace object is a frozen ESM binding shared across importers (spyOn throws
// "Cannot redefine property"), and a default `import fs from 'node:fs'` resolves
// to a *different*, disconnected object that never sees store.ts's real calls
// (verified empirically: it reports 0 calls even against an unmemoized store.ts).
// `vi.mock` intercepts at module-resolution level instead, so it sees calls from
// every importer of 'node:fs', including store.ts.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDomain, putRecord, setBaseDirForTests } from '../src/experimental/fingerprinting/store';
import type { FingerprintRecord } from '../src/experimental/fingerprinting/types';

const TMP = path.join(process.cwd(), '.tmp-fp-store-cache');
setBaseDirForTests(TMP);

afterEach(() => {
  (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockClear();
  fs.rmSync(TMP, { recursive: true, force: true });
  setBaseDirForTests(TMP); // clears the memo between tests
});

function rec(selector: string): FingerprintRecord {
  return {
    role: 'button', name: 'Post', text: 'Post', tag: 'button', type: null,
    attrs: {}, classList: [], htmlId: '', ordinal: 0, cx: 10, cy: 20,
    neighborText: '', landmark: '',
    selector, capturedAt: 1, lastSeenAt: 1, hits: 1,
  };
}

describe('loadDomain memoization', () => {
  it('parses the file once across repeated reads', () => {
    putRecord('x.com', '/home', '#post', rec('#post'));
    (fs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockClear();
    loadDomain('x.com');
    loadDomain('x.com');
    loadDomain('x.com');
    expect(fs.readFileSync).toHaveBeenCalledTimes(0); // saveDomain already seeded the memo
  });

  it('re-parses when the file changes underneath it (another process wrote)', () => {
    putRecord('x.com', '/home', '#post', rec('#post'));
    expect(Object.keys(loadDomain('x.com').routes['/home'])).toEqual(['#post']);

    // Simulate an out-of-process write: different content, forced-newer mtime.
    const file = path.join(TMP, 'x.com.json');
    const store = { domain: 'x.com', routes: { '/home': { '#other': rec('#other') } } };
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);

    expect(Object.keys(loadDomain('x.com').routes['/home'])).toEqual(['#other']);
  });

  it('returns an empty store and does not cache when the file is absent', () => {
    expect(loadDomain('never-written.com')).toEqual({ domain: 'never-written.com', routes: {} });
    putRecord('never-written.com', '/', '#a', rec('#a'));
    expect(loadDomain('never-written.com').routes['/']['#a'].selector).toBe('#a');
  });

  it('a write through putRecord is visible to the next read', () => {
    putRecord('y.com', '/', '#a', rec('#a'));
    putRecord('y.com', '/', '#b', rec('#b'));
    expect(Object.keys(loadDomain('y.com').routes['/']).sort()).toEqual(['#a', '#b']);
  });

  it('setBaseDirForTests clears the memo', () => {
    putRecord('z.com', '/', '#a', rec('#a'));
    expect(loadDomain('z.com').routes['/']).toBeDefined();
    fs.rmSync(TMP, { recursive: true, force: true });
    setBaseDirForTests(TMP);
    expect(loadDomain('z.com')).toEqual({ domain: 'z.com', routes: {} });
  });
});
