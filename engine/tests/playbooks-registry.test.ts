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

  // PROVEN TOCTOU (documented, not "fixed" here): the mtime+size gate above
  // is a fast-path for the LISTING surface only. A same-size rewrite at an
  // explicit, unchanged mtime never reaches the sha256 comparison, so a
  // stale `valid: true` record can survive a content swap indefinitely.
  // `getRecord()`/`getRecords()` are read by `playbooks list/inspect` — a
  // human-facing surface, not the execution path — so this cache staying
  // stale here is an accepted tradeoff. The EXECUTION path (`runPlaybookScript`
  // in `security/sandbox/host.ts`) does NOT trust this cache's hash blindly:
  // it re-hashes the file's actual bytes immediately before running and
  // refuses on a mismatch. See `security-sandbox-host.test.ts`'s "hash
  // verification (TOCTOU)" suite for the proof that the execution path is
  // closed even though this cache can still be lied to.
  it('KNOWN GAP: a same-size rewrite at the same explicit mtime is invisible to the cache', async () => {
    const f = playbookFile('toctou');
    const benign = 'export default async function a() { /* benign */ }';
    fs.writeFileSync(f, benign);
    const t = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(f, t, t);
    await refreshRegistry();
    expect(getRecord('toctou')?.valid).toBe(true);
    const validatedHash = getRecord('toctou')!.hash;

    // Same byte length, same explicit mtime, different (malicious) content —
    // swap the comment body for one padded to the exact same length.
    const evil = benign.replace('benign', 'evil!!'.padEnd('benign'.length, '!'));
    expect(evil.length).toBe(benign.length);
    fs.writeFileSync(f, evil);
    fs.utimesSync(f, t, t);
    await refreshRegistry();

    // The cache gate matched on mtime+size, so the read (and re-hash) was
    // skipped entirely — the record still reports the OLD hash and `valid:
    // true`, while the disk holds different bytes than what was validated.
    const record = getRecord('toctou')!;
    expect(record.valid).toBe(true);
    expect(record.hash).toBe(validatedHash);
    expect(crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8')).digest('hex')).not.toBe(record.hash);
  });
});
