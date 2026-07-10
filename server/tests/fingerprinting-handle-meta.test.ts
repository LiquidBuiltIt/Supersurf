import { describe, it, expect } from 'vitest';
import { mergeHandleMeta } from '../src/experimental/fingerprinting/handle-meta';

describe('mergeHandleMeta', () => {
  it('first-seen name becomes canonical (outcome=new)', () => {
    const r = mergeHandleMeta(undefined, { name: 'First Name', purpose: 'enter applicant first name' });
    expect(r.name).toBe('first_name');
    expect(r.purpose).toBe('enter applicant first name');
    expect(r.outcome).toBe('new');
    expect(r.normalized).toBe(true);
    expect(r.aliases).toBeUndefined();
  });

  it('same canonical name on re-capture does not create an alias (outcome=existing)', () => {
    const existing = { name: 'first_name', aliases: {} as Record<string, number> };
    const r = mergeHandleMeta(existing, { name: 'first_name' });
    expect(r.name).toBe('first_name');
    expect(r.outcome).toBe('existing');
    expect(r.addedAlias).toBeUndefined();
  });

  it('a differing name is harvested as an alias, canonical is preserved (outcome=alias)', () => {
    const existing = { name: 'first_name', aliases: {} as Record<string, number> };
    const r = mergeHandleMeta(existing, { name: 'firstNameInput' });
    expect(r.name).toBe('first_name'); // canonical untouched
    // normalizeName does not split camelCase (see naming.ts / fingerprinting-naming.test.ts) —
    // only separators collapse, so 'firstNameInput' normalizes to 'firstnameinput'.
    expect(r.aliases).toEqual({ firstnameinput: 1 });
    expect(r.outcome).toBe('alias');
    expect(r.addedAlias).toBe('firstnameinput');
    expect(r.aliasFreq).toBe(1);
  });

  it('re-seeing an existing alias increments its frequency, not a new key', () => {
    const existing = { name: 'first_name', aliases: { first_name_input: 2 } };
    const r = mergeHandleMeta(existing, { name: 'first-name-input' });
    expect(r.aliases).toEqual({ first_name_input: 3 });
    expect(r.outcome).toBe('alias');
    expect(r.aliasFreq).toBe(3);
  });

  it('incoming name matching an existing alias still does not displace canonical', () => {
    const existing = { name: 'first_name', aliases: { fname: 1 } };
    const r = mergeHandleMeta(existing, { name: 'fname' });
    expect(r.name).toBe('first_name');
    expect(r.aliases).toEqual({ fname: 2 });
  });

  it('no usable name -> outcome=none, preserves existing name/aliases, updates purpose', () => {
    const existing = { name: 'first_name', aliases: { fname: 1 }, purpose: 'old' };
    const r = mergeHandleMeta(existing, { name: '   ', purpose: 'new intent' });
    expect(r.outcome).toBe('none');
    expect(r.name).toBe('first_name');
    expect(r.aliases).toEqual({ fname: 1 });
    expect(r.purpose).toBe('new intent'); // latest non-empty purpose wins
  });

  it('purpose is stored trimmed; empty purpose keeps the prior purpose', () => {
    const existing = { name: 'x', purpose: 'keep me' };
    const r = mergeHandleMeta(existing, { name: 'x', purpose: '   ' });
    expect(r.purpose).toBe('keep me');
  });
});
