import { describe, it, expect } from 'vitest';
import { mergeHandleMeta } from '../src/experimental/fingerprinting/handle-meta';

describe('mergeHandleMeta', () => {
  it('first-seen name becomes canonical (outcome=new)', () => {
    const r = mergeHandleMeta(undefined, { name: 'First Name', purpose: 'enter applicant first name' });
    expect(r.name).toBe('first_name');
    expect(r.purpose).toBe('enter applicant first name');
    expect(r.outcome).toBe('new');
    expect(r.normalized).toBe(true);
    expect(r.ignoredName).toBeUndefined();
  });

  it('same canonical name on re-capture is a plain re-hit (outcome=existing)', () => {
    const r = mergeHandleMeta({ name: 'first_name' }, { name: 'first_name' });
    expect(r.name).toBe('first_name');
    expect(r.outcome).toBe('existing');
    expect(r.ignoredName).toBeUndefined();
  });

  it('a differing name is a NO-OP: canonical is sticky and nothing is stored for the new name', () => {
    const r = mergeHandleMeta({ name: 'first_name' }, { name: 'firstNameInput' });
    expect(r.name).toBe('first_name');
    expect(r.outcome).toBe('ignored');
    // normalizeName does not split camelCase (see naming.ts) — only separators collapse.
    expect(r.ignoredName).toBe('firstnameinput');
    // The whole point: no alias map comes back out of the merge.
    expect((r as Record<string, unknown>).aliases).toBeUndefined();
  });

  it('repeating the same differing name never accumulates state', () => {
    const first = mergeHandleMeta({ name: 'first_name' }, { name: 'fname' });
    const second = mergeHandleMeta({ name: 'first_name' }, { name: 'fname' });
    expect(first.outcome).toBe('ignored');
    expect(second.outcome).toBe('ignored');
    expect(second.ignoredName).toBe('fname');
    expect(second.name).toBe('first_name');
  });

  it('no usable name -> outcome=none, preserves canonical, updates purpose', () => {
    const r = mergeHandleMeta({ name: 'first_name', purpose: 'old' }, { name: '   ', purpose: 'new intent' });
    expect(r.outcome).toBe('none');
    expect(r.name).toBe('first_name');
    expect(r.purpose).toBe('new intent'); // latest non-empty purpose wins
    expect(r.ignoredName).toBeUndefined();
  });

  it('purpose is stored trimmed; empty purpose keeps the prior purpose', () => {
    const r = mergeHandleMeta({ name: 'x', purpose: 'keep me' }, { name: 'x', purpose: '   ' });
    expect(r.purpose).toBe('keep me');
  });
});
