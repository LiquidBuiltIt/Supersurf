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
    const r = mergeHandleMeta({ name: 'first_name' }, { name: 'First Name Input' });
    expect(r.name).toBe('first_name');
    expect(r.outcome).toBe('ignored');
    expect(r.ignoredName).toBe('first_name_input');
    // The whole point: no alias map comes back out of the merge.
    expect((r as Record<string, unknown>).aliases).toBeUndefined();
  });

  it('repeating the same differing name never accumulates state', () => {
    const first = mergeHandleMeta({ name: 'first_name' }, { name: 'first_name_alt' });
    const second = mergeHandleMeta({ name: 'first_name' }, { name: 'first_name_alt' });
    expect(first.outcome).toBe('ignored');
    expect(second.outcome).toBe('ignored');
    expect(second.ignoredName).toBe('first_name_alt');
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
    const r = mergeHandleMeta({ name: 'save_button', purpose: 'keep me' }, { name: 'save_button', purpose: '   ' });
    expect(r.outcome).toBe('existing'); // same name re-hit — not the single-word rejection branch
    expect(r.purpose).toBe('keep me');
  });

  it('a single-word name (no underscore) is not stored — it could never resolve back', () => {
    const r = mergeHandleMeta(undefined, { name: 'submit', purpose: 'submit the form' });
    expect(r.outcome).toBe('none');
    expect(r.name).toBeUndefined(); // must NOT become the canonical name
    expect(r.purpose).toBe('submit the form');
    expect(r.ignoredName).toBeUndefined();
  });

  it('a single-word name never overrides an existing canonical name', () => {
    const r = mergeHandleMeta({ name: 'first_name' }, { name: 'submit' });
    expect(r.outcome).toBe('none');
    expect(r.name).toBe('first_name'); // canonical untouched
    expect(r.ignoredName).toBeUndefined();
  });
});
