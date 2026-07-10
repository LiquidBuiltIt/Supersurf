import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureOnResolve } from '../src/experimental/fingerprinting/index';
import { getRecord, setBaseDirForTests } from '../src/experimental/fingerprinting/store';
import { experimentRegistry } from '../src/experimental/index';

// A fake evalFn returning a fixed fingerprint JSON (shape captureExpr would produce).
const FP = JSON.stringify({
  role: 'textbox', name: 'First name', text: '', tag: 'input', type: 'text',
  attrs: {}, classList: [], htmlId: 'fn', ordinal: 0, cx: 10, cy: 20,
  neighborText: '', landmark: '', selector: '#fn',
});
const fakeEval = async (_expr: string) => FP;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-fp-'));
  setBaseDirForTests(tmp);
  experimentRegistry.enable('fingerprinting');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('captureOnResolve — handle binding', () => {
  it('binds a first-seen name as canonical and emits handle.capture (outcome=new)', async () => {
    const events: any[] = [];
    await captureOnResolve(fakeEval, 'https://ashbyhq.com/apply', '#fn',
      { name: 'First Name', purpose: 'enter first name' }, (ev) => events.push(ev));

    const rec = getRecord('ashbyhq.com', '/apply', '#fn');
    expect(rec?.handleName).toBe('first_name');
    expect(rec?.purpose).toBe('enter first name');
    const cap = events.find(e => e.event === 'handle.capture');
    expect(cap).toMatchObject({ outcome: 'new', name: 'first_name', purpose_present: true, normalized: true, aliasCount: 0 });
    expect(events.some(e => e.event === 'handle.alias_added')).toBe(false);
  });

  it('harvests a differing name as an alias without overwriting, emits both events', async () => {
    await captureOnResolve(fakeEval, 'https://ashbyhq.com/apply', '#fn', { name: 'first_name' });
    const events: any[] = [];
    await captureOnResolve(fakeEval, 'https://ashbyhq.com/apply', '#fn',
      { name: 'firstNameInput' }, (ev) => events.push(ev));

    const rec = getRecord('ashbyhq.com', '/apply', '#fn');
    expect(rec?.handleName).toBe('first_name');
    expect(rec?.aliases).toEqual({ firstnameinput: 1 });
    expect(events.find(e => e.event === 'handle.capture')).toMatchObject({ outcome: 'alias', aliasCount: 1 });
    expect(events.find(e => e.event === 'handle.alias_added')).toMatchObject({ addedAlias: 'firstnameinput', aliasFreq: 1 });
  });

  it('does not throw and emits nothing when no name is supplied', async () => {
    const events: any[] = [];
    await expect(
      captureOnResolve(fakeEval, 'https://ashbyhq.com/apply', '#fn', undefined, (ev) => events.push(ev))
    ).resolves.toBeUndefined();
    const rec = getRecord('ashbyhq.com', '/apply', '#fn');
    expect(rec?.handleName).toBeUndefined();
    expect(events.length).toBe(0); // outcome 'none' emits no handle events
  });
});
