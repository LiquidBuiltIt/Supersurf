import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadJsonConfig } from '../config/loaders';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('loadJsonConfig', () => {
  it('returns empty + no warning when file missing', () => {
    const { config, warnings } = loadJsonConfig(path.join(tmpDir, 'absent.json'));
    expect(config).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('returns parsed object for valid JSON', () => {
    const p = path.join(tmpDir, 'c.json');
    fs.writeFileSync(p, JSON.stringify({ daemon: { port: 6666 } }));
    const { config, warnings } = loadJsonConfig(p);
    expect(config).toEqual({ daemon: { port: 6666 } });
    expect(warnings).toEqual([]);
  });

  it('returns empty + warning when JSON is malformed', () => {
    const p = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(p, '{not valid');
    const { config, warnings } = loadJsonConfig(p);
    expect(config).toEqual({});
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/malformed/i);
  });

  it('returns empty + warning when file is not an object', () => {
    const p = path.join(tmpDir, 'arr.json');
    fs.writeFileSync(p, '[1,2,3]');
    const { config, warnings } = loadJsonConfig(p);
    expect(config).toEqual({});
    expect(warnings[0]).toMatch(/object/i);
  });
});
