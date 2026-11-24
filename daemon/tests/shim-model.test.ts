import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { supersurfDir } from 'shared';
import { cmpVersion, shimModelInUse, upgradePending } from '../src/handoff';

describe('shimModelInUse', () => {
  const base = { servedShim: false, startReason: 'unknown', relay: false, takeover: false };
  it('is false for a legacy daemon (all three signals off)', () => {
    expect(shimModelInUse(base)).toBe(false);
    expect(shimModelInUse({ ...base, startReason: 'start' })).toBe(false);
  });
  it('is true when a shim_register was accepted', () => expect(shimModelInUse({ ...base, servedShim: true })).toBe(true));
  it('is true when the shim started the daemon', () => expect(shimModelInUse({ ...base, startReason: 'shim' })).toBe(true));
  it('is true when agents.relay is on', () => expect(shimModelInUse({ ...base, relay: true })).toBe(true));
  it('is true for a hand-off successor (--takeover): it exists only because the old daemon was in the shim model', () => {
    expect(shimModelInUse({ ...base, takeover: true })).toBe(true);
  });
  it('is false for an entry file alone: the input does not exist any more', () => {
    expect(shimModelInUse({ ...base, entryExists: true } as any)).toBe(false);
  });
});

describe('cmpVersion (same semantics as server/shim/ensure.go)', () => {
  const table: [string, string, number][] = [
    ['4.1.0', '4.1.0', 0],
    ['4.1.0', '4.1.1', -1],
    ['4.1.1', '4.1.0', 1],
    ['4.10.0', '4.9.0', 1],
    ['5.0.0', '4.99.99', 1],
    ['v4.1.0', '4.1.0', 0],
    ['5.0.0-rc.1', '5.0.0', -1],
    ['5.0.0', '5.0.0-rc.1', 1],
    ['5.0.0-rc.1', '5.0.0-rc.2', -1],
    ['5.0.0-rc.2', '5.0.0-rc.2', 0],
    ['5.0.0-rc.1', '4.9.9', 1],
    ['5.0', '5.0.0', 0],
    ['5', '5.0.1', -1],
    ['1.0.0+b', '1.0.0', -1], // Go treats build metadata like a pre-release suffix
    ['x.y.z', '0.0.0', 0], // non-numeric parts read as 0
  ];
  for (const [a, b, want] of table) it(`${a} vs ${b} = ${want}`, () => expect(cmpVersion(a, b)).toBe(want));
});

describe('upgradePending', () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'));
    saved = process.env.HOME;
    process.env.HOME = home;
    fs.mkdirSync(path.join(supersurfDir(), 'daemon'), { recursive: true });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const writeEntryFile = (version: string) =>
    fs.writeFileSync(path.join(supersurfDir(), 'daemon', 'entry'), JSON.stringify({ node: process.execPath, main: process.execPath, version }));

  it('is null with no entry', () => {
    expect(upgradePending('4.1.0')).toBeNull();
  });
  it('names from and to when entry is newer', () => {
    writeEntryFile('5.0.0');
    expect(upgradePending('4.1.0')).toEqual({ from: '4.1.0', to: '5.0.0' });
  });
  it('is null for an equal, older or broken entry', () => {
    writeEntryFile('4.1.0');
    expect(upgradePending('4.1.0')).toBeNull();
    writeEntryFile('4.0.0');
    expect(upgradePending('4.1.0')).toBeNull();
    fs.writeFileSync(path.join(supersurfDir(), 'daemon', 'entry'), '{broken');
    expect(upgradePending('4.1.0')).toBeNull();
  });
});
