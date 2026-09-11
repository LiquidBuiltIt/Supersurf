import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateElementTargets } from '../src/security/element-targets';
import { validateFile } from '../src/security/validate';
import { setBaseDirForTests, putRecord } from '../src/experimental/fingerprinting/store';
import type { PlaybookMeta } from '../src/security/meta';
import type { FingerprintRecord } from '../src/experimental/fingerprinting/types';

const TMP = path.join(os.tmpdir(), 'ss-element-targets-fp');

function meta(overrides: Partial<PlaybookMeta> = {}): PlaybookMeta {
  return { description: 'x', ...overrides };
}

/** Minimal FingerprintRecord with a handleName — the field this check queries. */
function rec(selector: string, handleName?: string): FingerprintRecord {
  return {
    role: 'button', name: 'Submit', text: 'Submit', tag: 'button', type: null,
    attrs: {}, classList: [], htmlId: '', ordinal: 0, cx: 1, cy: 1,
    neighborText: '', landmark: '',
    selector, capturedAt: 1, lastSeenAt: 1, hits: 1,
    ...(handleName ? { handleName } : {}),
  };
}

setBaseDirForTests(TMP);

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  setBaseDirForTests(TMP); // clears the memo between tests
});

describe('validateElementTargets — legal forms', () => {
  it('accepts a plain string literal handle that is recorded', () => {
    putRecord('x.com', '/', '#submit', rec('#submit', 'submit_review'));
    const src = `export default async function ({ supersurf }) { await supersurf.click('@submit_review'); }`;
    expect(validateElementTargets(src, meta({ startingPoint: 'x.com' }))).toEqual({});
  });

  it('accepts a const-bound identifier resolved to a recorded handle', () => {
    putRecord('x.com', '/', '#submit', rec('#submit', 'submit_review'));
    const src = `
const h = '@submit_review';
export default async function ({ supersurf }) { await supersurf.click(h); }`;
    expect(validateElementTargets(src, meta({ startingPoint: 'x.com' }))).toEqual({});
  });
});

describe('validateElementTargets — illegal forms (rejected on FORM, message names the form)', () => {
  // RED-MAKER for each: delete the corresponding `case` branch (or the whole
  // switch) in `resolveTarget()` (src/security/element-targets.ts) and the
  // call would fall through to `default` or pass through unrejected.

  it('rejects string concatenation', () => {
    const src = `export default async function ({ supersurf }) {
  const i = 3;
  await supersurf.click('#row-' + i);
}`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('concatenation');
  });

  it('rejects a template literal', () => {
    const src = 'export default async function ({ supersurf }) { const i = 3; await supersurf.click(`#row-${i}`); }';
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('template literal');
  });

  it('rejects a member expression', () => {
    const src = `const S = { tagPicker: '#tag' };
export default async function ({ supersurf }) { await supersurf.click(S.tagPicker); }`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('member expression');
  });

  it('rejects a loop variable', () => {
    const src = `export default async function ({ supersurf }) {
  const rows = ['#a', '#b'];
  for (const row of rows) { await supersurf.click(row); }
}`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('not `const`-bound to a string literal');
  });

  it('rejects a function parameter', () => {
    const src = `async function helper(supersurf, target) { await supersurf.click(target); }
export default async function ({ supersurf }) { await helper(supersurf, '#x'); }`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('not `const`-bound to a string literal');
  });

  it('rejects a `let`-bound identifier (not `const`)', () => {
    const src = `let h = '@submit_review';
export default async function ({ supersurf }) { await supersurf.click(h); }`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('not `const`-bound to a string literal');
  });
});

describe('validateElementTargets — handle existence (§2, REJECT not warn)', () => {
  // RED-MAKER: delete the `if (!handleIsRecorded(...))` branch in
  // element-targets.ts and an unrecorded handle would silently pass.

  it('fails an unrecorded handle', () => {
    const src = `export default async function ({ supersurf }) { await supersurf.click('@ghost_button'); }`;
    const { error } = validateElementTargets(src, meta({ startingPoint: 'x.com' }));
    expect(error).toContain('no recorded handle named "ghost_button"');
  });

  it('passes a recorded handle', () => {
    putRecord('x.com', '/', '#submit', rec('#submit', 'submit_review'));
    const src = `export default async function ({ supersurf }) { await supersurf.click('@submit_review'); }`;
    expect(validateElementTargets(src, meta({ startingPoint: 'x.com' }))).toEqual({});
  });

  it('normalizes the handle name via normalizeName before lookup (does not reimplement it)', () => {
    putRecord('x.com', '/', '#submit', rec('#submit', 'submit_review'));
    // '@Submit Review!' -> normalizeName -> 'submit_review'
    const src = `export default async function ({ supersurf }) { await supersurf.click('@Submit Review!'); }`;
    expect(validateElementTargets(src, meta({ startingPoint: 'x.com' }))).toEqual({});
  });

  it('startingPoint is a HINT, not a scope: a handle recorded under a different domain still passes', () => {
    // RED-MAKER: change handleIsRecorded to `return hintDomain ? storeHasHandle(loadDomain(hintDomain), normalized) : ...`
    // (i.e. stop after the hint and never fall back to loadAllDomains) and this goes red.
    putRecord('other-domain.com', '/', '#submit', rec('#submit', 'submit_review'));
    const src = `export default async function ({ supersurf }) { await supersurf.click('@submit_review'); }`;
    expect(validateElementTargets(src, meta({ startingPoint: 'x.com' }))).toEqual({});
  });

  it('finds a handle with no startingPoint hint at all (scans every domain file)', () => {
    putRecord('somewhere.com', '/', '#submit', rec('#submit', 'submit_review'));
    const src = `export default async function ({ supersurf }) { await supersurf.click('@submit_review'); }`;
    expect(validateElementTargets(src, meta())).toEqual({});
  });
});

describe('validateElementTargets — meta.useRawSelectors is a PERMISSION GATE (§3)', () => {
  // RED-MAKER: change `!meta.useRawSelectors` to always-false (i.e. never enforce
  // strict mode) and the "strict-mode rejects a raw selector" case goes red.

  it('strict mode (flag absent) rejects a raw CSS selector', () => {
    const src = `export default async function ({ supersurf }) { await supersurf.click('#submit'); }`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('raw CSS selectors are not allowed');
  });

  it('strict mode (flag explicitly false) rejects a raw CSS selector', () => {
    const src = `export default async function ({ supersurf }) { await supersurf.click('#submit'); }`;
    const { error } = validateElementTargets(src, meta({ useRawSelectors: false }));
    expect(error).toContain('raw CSS selectors are not allowed');
  });

  it('useRawSelectors: true admits a raw CSS selector', () => {
    const src = `export default async function ({ supersurf }) { await supersurf.click('#submit'); }`;
    expect(validateElementTargets(src, meta({ useRawSelectors: true }))).toEqual({});
  });

  it('useRawSelectors: true is NOT "skip the check" — an unrecorded handle in the same script still fails', () => {
    // RED-MAKER: change the gate to short-circuit the whole scan when useRawSelectors
    // is true (e.g. `if (meta.useRawSelectors) return {};` at the top) and this goes red.
    const src = `export default async function ({ supersurf }) {
  await supersurf.click('#submit');
  await supersurf.hover('@ghost_button');
}`;
    const { error } = validateElementTargets(src, meta({ useRawSelectors: true }));
    expect(error).toContain('no recorded handle named "ghost_button"');
  });

  it('useRawSelectors: true still enforces the form check (§1) on every target', () => {
    const src = `export default async function ({ supersurf }) {
  const i = 3;
  await supersurf.click('#row-' + i);
}`;
    const { error } = validateElementTargets(src, meta({ useRawSelectors: true }));
    expect(error).toContain('concatenation');
  });
});

describe('validateElementTargets — non-target arguments and calls are ignored', () => {
  it('ignores a non-target supersurf method (e.g. goto/evaluate) entirely', () => {
    const src = `export default async function ({ supersurf }) { await supersurf.goto('https://x.com'); }`;
    expect(validateElementTargets(src, meta())).toEqual({});
  });

  it('ignores a bare (non-supersurf) function call named click', () => {
    const src = `function click(x) { return x; }
export default async function () { click(document); }`;
    expect(validateElementTargets(src, meta())).toEqual({});
  });
});

describe('validateFile — wired end to end', () => {
  it('fails a whole file on an unrecorded handle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-et-file-'));
    const file = path.join(dir, 'x.playbook.js');
    fs.writeFileSync(file, `export const meta = { description: 'x', startingPoint: 'x.com' };
export default async function ({ supersurf }) { await supersurf.click('@ghost_button'); }
`);
    const rec = await validateFile(file);
    expect(rec.valid).toBe(false);
    expect(rec.error).toContain('no recorded handle named "ghost_button"');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a whole file whose handles are all recorded', async () => {
    putRecord('x.com', '/', '#submit', rec('#submit', 'submit_review'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-et-file-'));
    const file = path.join(dir, 'x.playbook.js');
    fs.writeFileSync(file, `export const meta = { description: 'x', startingPoint: 'x.com' };
export default async function ({ supersurf }) { await supersurf.click('@submit_review'); }
`);
    const result = await validateFile(file);
    expect(result.valid).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
