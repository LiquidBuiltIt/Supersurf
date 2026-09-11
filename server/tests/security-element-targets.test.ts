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

describe('validateElementTargets — unrecognized call forms are REJECTED, not skipped (fix round 1)', () => {
  // These six cases were empirically demonstrated in adversarial review to
  // bypass validation entirely (validateElementTargets returned {} on code
  // that should have been rejected). RED-MAKER notes below point at the
  // specific removal that reopens each hole.

  it('rejects destructuring the supersurf client object', () => {
    // RED-MAKER: remove the `VariableDeclarator` visitor's ObjectPattern
    // branch in element-targets.ts — the call `click('@ghost')` below has a
    // bare Identifier callee, invisible to the CallExpression walk, so
    // nothing else in the file catches this.
    const src = `const { click } = supersurf;
export default async function () { await click('@ghost'); }`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('destructures the `supersurf` client object');
  });

  it('rejects aliasing a supersurf member to a variable', () => {
    // RED-MAKER: remove the `VariableDeclarator` visitor's MemberExpression
    // branch in element-targets.ts. Same blind spot as destructuring: `c('#raw')`
    // has a bare Identifier callee.
    const src = `const c = supersurf.click;
export default async function () { await c('#raw'); }`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('assigns a `supersurf` member to a variable');
  });

  it('rejects computed member access on supersurf', () => {
    // RED-MAKER: remove the `if (callee.computed)` branch in the CallExpression
    // walker — the original code returned early on `callee.computed` without
    // rejecting, silently skipping the call.
    const src = `export default async function () { await supersurf['click']('#raw'); }`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('computed member access');
  });

  it('checks wait() as an element target when its argument is a string: unrecorded handle fails', () => {
    // RED-MAKER: remove the `method === 'wait'` branch (or the TARGET_METHODS.has
    // fallthrough it replaces) — `wait` was previously absent from TARGET_METHODS
    // entirely, so any string argument passed through unchecked.
    const src = `export default async function ({ supersurf }) { await supersurf.wait('@ghost_button'); }`;
    const { error } = validateElementTargets(src, meta({ startingPoint: 'x.com' }));
    expect(error).toContain('no recorded handle named "ghost_button"');
  });

  it('checks wait() as an element target: strict mode rejects a raw selector', () => {
    const src = `export default async function ({ supersurf }) { await supersurf.wait('#done'); }`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('raw CSS selectors are not allowed');
  });

  it('does not check a numeric wait() argument (it is a delay, not a target)', () => {
    const src = `export default async function ({ supersurf }) { await supersurf.wait(1500); }`;
    expect(validateElementTargets(src, meta())).toEqual({});
  });

  it('checks both drag() targets: an unrecorded "from" handle fails', () => {
    // RED-MAKER: remove the `method === 'drag'` branch — `drag` was previously
    // absent from TARGET_METHODS entirely, so neither argument was checked.
    putRecord('x.com', '/', '#to', rec('#to', 'drop_zone'));
    const src = `export default async function ({ supersurf }) { await supersurf.drag('@ghost_from', '@drop_zone'); }`;
    const { error } = validateElementTargets(src, meta({ startingPoint: 'x.com' }));
    expect(error).toContain('no recorded handle named "ghost_from"');
  });

  it('checks both drag() targets: a recorded "from" but unrecorded "to" handle fails', () => {
    putRecord('x.com', '/', '#from', rec('#from', 'drag_handle'));
    const src = `export default async function ({ supersurf }) { await supersurf.drag('@drag_handle', '@ghost_to'); }`;
    const { error } = validateElementTargets(src, meta({ startingPoint: 'x.com' }));
    expect(error).toContain('no recorded handle named "ghost_to"');
  });

  it('const-shadowing direction A: an unrelated const bound to a recorded handle must not mask a real unrecorded binding', () => {
    // RED-MAKER: change the ambiguity check to "first declaration wins" (the
    // pre-fix behavior) — this would then resolve `h` to '@recorded' (whichever
    // binding scanned first) and pass, instead of rejecting the ambiguity.
    putRecord('x.com', '/', '#ok', rec('#ok', 'recorded'));
    const src = `
function other() { const h = '@recorded'; return h; }
export default async function ({ supersurf }) {
  const h = '@unrecorded';
  await supersurf.click(h);
}`;
    const { error } = validateElementTargets(src, meta({ startingPoint: 'x.com' }));
    expect(error).toContain('const`-bound to a string literal more than once');
  });

  it('const-shadowing direction B: an unrelated const bound to a raw selector must not mask a legal recorded handle', () => {
    // RED-MAKER: same as above — first-wins would resolve `h` to whichever
    // binding is scanned first, silently accepting or rejecting based on
    // declaration order rather than flagging the ambiguity.
    putRecord('x.com', '/', '#ok', rec('#ok', 'recorded'));
    const src = `
function other() { const h = '#raw'; return h; }
export default async function ({ supersurf }) {
  const h = '@recorded';
  await supersurf.click(h);
}`;
    const { error } = validateElementTargets(src, meta({ startingPoint: 'x.com' }));
    expect(error).toContain('const`-bound to a string literal more than once');
  });

  it('rejects aliasing the whole supersurf client object itself to another variable (fix round 2)', () => {
    // RED-MAKER: remove the `VariableDeclarator` visitor's object-alias branch
    // (the `node.init?.type === 'Identifier' && node.init.name === 'supersurf'`
    // check) in element-targets.ts — `s2.click('@ghost_via_reassign')` has a
    // callee object named `s2`, not `supersurf`, so the CallExpression walk's
    // `callee.object.name !== 'supersurf'` guard would silently skip it.
    const src = `let s2 = supersurf;
export default async function () { await s2.click('@ghost_via_reassign'); }`;
    const { error } = validateElementTargets(src, meta());
    expect(error).toContain('aliases the `supersurf` client object itself');
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
