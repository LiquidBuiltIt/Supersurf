import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureConfigFile } from '../config/scaffold';
import { SCAFFOLD_DEFAULTS } from '../config/defaults';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaf-')); });
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('ensureConfigFile', () => {
  it('creates file with SCAFFOLD_DEFAULTS when missing', () => {
    const p = path.join(tmpDir, 'sub', 'config.json');
    const result = ensureConfigFile(p);
    expect(result.created).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(parsed).toEqual(SCAFFOLD_DEFAULTS);
  });

  it('leaves existing file untouched', () => {
    const p = path.join(tmpDir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ daemon: { port: 1111 } }));
    const result = ensureConfigFile(p);
    expect(result.created).toBe(false);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(parsed).toEqual({ daemon: { port: 1111 } });
  });

  it('creates intermediate directories', () => {
    const p = path.join(tmpDir, 'a', 'b', 'c', 'config.json');
    ensureConfigFile(p);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('uses the wx flag to fail closed on a concurrent writer (TOCTOU race)', () => {
    // The defensive fix in scaffold.ts writes with flag 'wx', which causes
    // fs.writeFileSync to throw EEXIST instead of overwriting if a concurrent
    // daemon raced past the existsSync check. We assert the flag is present
    // by reading the source — mocking fs in ESM is not configurable.
    const src = fs.readFileSync(path.join(__dirname, '..', 'config', 'scaffold.ts'), 'utf-8');
    expect(src).toMatch(/flag:\s*['"]wx['"]/);
    expect(src).toMatch(/err\?\.code === ['"]EEXIST['"]/);
  });
});
