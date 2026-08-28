import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { setPlaybooksDirForTests, playbookFile } from '../src/playbooks/paths';
import {
  refreshRegistry, getRecords, getRecord, getInvalidRecords,
  setValidatorForTests, resetRegistryForTests,
} from '../src/playbooks/registry';
import type { ValidationRecord } from '../src/security/validate';

let dir: string;
let calls: string[];

function fakeRecord(file: string, over: Partial<ValidationRecord> = {}): ValidationRecord {
  const name = path.basename(file).replace('.playbook.js', '');
  return {
    file, name, hash: 'h', valid: true,
    meta: { description: `does ${name}`, startingPoint: 'example.com' },
    signature: `${name}()`, validatedAt: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-reg-'));
  setPlaybooksDirForTests(dir);
  resetRegistryForTests();
  calls = [];
  setValidatorForTests(async (p: string) => {
    calls.push(p);
    const src = fs.readFileSync(p, 'utf8');
    // `ValidationRecord.hash` is contractually the sha256 of the file, and the
    // registry's content gate compares its own sha256 against it. A mock that
    // invents any other hash makes that gate miss on every pass.
    const hash = crypto.createHash('sha256').update(src).digest('hex');
    if (src.includes('BAD')) return fakeRecord(p, { hash, valid: false, error: 'blocked API: require', meta: undefined });
    return fakeRecord(p, { hash });
  });
});
afterEach(() => {
  setValidatorForTests(null);
  resetRegistryForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('refreshRegistry', () => {
  it('validates every playbook on the first pass', async () => {
    fs.writeFileSync(playbookFile('a'), 'export default async function a() {}');
    fs.writeFileSync(playbookFile('b'), 'export default async function b() {}');
    await refreshRegistry();
    expect(calls.length).toBe(2);
    expect(getRecords().map(r => r.name).sort()).toEqual(['a', 'b']);
  });

  it('does not re-validate an unchanged file', async () => {
    fs.writeFileSync(playbookFile('a'), 'export default async function a() {}');
    await refreshRegistry();
    await refreshRegistry();
    expect(calls.length).toBe(1);
  });

  it('re-validates when the content changes', async () => {
    const f = playbookFile('a');
    fs.writeFileSync(f, 'export default async function a() {}');
    await refreshRegistry();
    fs.writeFileSync(f, 'export default async function a() { /* changed */ }');
    fs.utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await refreshRegistry();
    expect(calls.length).toBe(2);
  });

  it('does not re-validate when only the mtime changed', async () => {
    const f = playbookFile('a');
    fs.writeFileSync(f, 'export default async function a() {}');
    await refreshRegistry();
    fs.utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await refreshRegistry();
    expect(calls.length).toBe(1);
  });

  it('drops the record for a deleted file', async () => {
    fs.writeFileSync(playbookFile('a'), 'export default async function a() {}');
    await refreshRegistry();
    fs.rmSync(playbookFile('a'));
    await refreshRegistry();
    expect(getRecords()).toEqual([]);
    expect(getRecord('a')).toBeUndefined();
  });

  it('keeps invalid files in the registry so the verdict can be reported', async () => {
    fs.writeFileSync(playbookFile('bad'), 'BAD');
    await refreshRegistry();
    const invalid = getInvalidRecords();
    expect(invalid.length).toBe(1);
    expect(invalid[0].error).toBe('blocked API: require');
    expect(getRecord('bad')?.valid).toBe(false);
  });

  it('records a validator throw as an invalid entry instead of failing the tool call', async () => {
    setValidatorForTests(async () => { throw new Error('parser exploded'); });
    fs.writeFileSync(playbookFile('a'), 'export default async function a() {}');
    await expect(refreshRegistry()).resolves.toBeUndefined();
    expect(getRecord('a')).toMatchObject({ valid: false, error: 'parser exploded' });
  });

  it('returns records sorted by name', async () => {
    fs.writeFileSync(playbookFile('z'), 'export default async function z() {}');
    fs.writeFileSync(playbookFile('m'), 'export default async function m() {}');
    fs.writeFileSync(playbookFile('a'), 'export default async function a() {}');
    await refreshRegistry();
    expect(getRecords().map(r => r.name)).toEqual(['a', 'm', 'z']);
  });
});
