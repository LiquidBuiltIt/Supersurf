import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { FileLogger } from '../logger/logger';

describe('FileLogger maxBytes', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-logger-rot-'));
    file = path.join(dir, 'daemon.log');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('without the option still truncates an existing file', () => {
    fs.writeFileSync(file, 'old line\n');
    new FileLogger(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });

  it('with maxBytes keeps the existing content and appends', () => {
    fs.writeFileSync(file, 'old line\n');
    const l = new FileLogger(file, { maxBytes: 10_000 });
    l.enable();
    l.log('new line');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith('old line\n')).toBe(true);
    expect(text).toContain('new line');
  });

  it('rotates to .1 when a write would pass the cap, replacing an older .1', () => {
    fs.writeFileSync(file + '.1', 'ancient\n');
    const l = new FileLogger(file, { maxBytes: 300 });
    l.enable();
    for (let i = 0; i < 12; i++) l.log(`line-${i} ${'x'.repeat(40)}`);
    expect(fs.existsSync(file + '.1')).toBe(true);
    expect(fs.readFileSync(file + '.1', 'utf8')).not.toContain('ancient');
    expect(fs.statSync(file).size).toBeLessThanOrEqual(300);
    expect(fs.statSync(file + '.1').size).toBeLessThanOrEqual(300);
    expect(fs.readFileSync(file, 'utf8')).toContain('line-11');
  });

  it('counts the size of a file that already exists at construction', () => {
    fs.writeFileSync(file, 'x'.repeat(290));
    const l = new FileLogger(file, { maxBytes: 300 });
    l.enable();
    l.log('hello');
    expect(fs.readFileSync(file + '.1', 'utf8')).toBe('x'.repeat(290));
    expect(fs.readFileSync(file, 'utf8')).toContain('hello');
  });
  it('a second writer rotating first does not destroy the first writer\'s history', () => {
    const a = new FileLogger(file, { maxBytes: 1000 });
    a.enable();
    let n = 0;
    while (fs.statSync(file).size < 900) a.log(`a-line-${n++} ${'x'.repeat(30)}`);
    const b = new FileLogger(file, { maxBytes: 1000 });
    b.enable();
    while (!fs.existsSync(file + '.1')) b.log(`b-line ${'y'.repeat(30)}`);
    a.log('a-after', 'z'.repeat(100));
    expect(fs.readFileSync(file + '.1', 'utf8')).toContain('a-line-0');
  });
});
