import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// Serves the GitHub tags API and the tag tarball from a local file.
const served: { tarball: string } = { tarball: '' };
vi.mock('https', () => {
  const get = vi.fn((url: string, opts: any, cb?: any) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const { Readable } = require('stream');
    const res = url.startsWith('https://api.github.com/')
      ? Readable.from([JSON.stringify([{ name: 'v4.1.0' }])])
      : fs.createReadStream(served.tarball);
    res.statusCode = 200;
    res.headers = {};
    setImmediate(() => callback(res));
    return { on: () => ({}) };
  });
  return { default: { get }, get };
});

/** Build a GitHub-style tag tarball: <top>/<files>. */
function makeTarball(dir: string, files: Record<string, string>): string {
  const src = fs.mkdtempSync(path.join(dir, 'src-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(src, 'Supersurf-4.1.0', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  const out = path.join(dir, `t-${path.basename(src)}.tar.gz`);
  execFileSync('tar', ['czf', out, '-C', src, 'Supersurf-4.1.0']);
  return out;
}

describe('pullExtension cache replacement', () => {
  let home: string;
  let extDir: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-pull-'));
    process.env.HOME = home;
    extDir = path.join(home, '.supersurf', 'extension');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'manifest.json'), '{"version":"4.0.0"}');
    vi.resetModules();
  });
  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('installs the extension/ dir of a valid tag tarball', async () => {
    served.tarball = makeTarball(home, {
      'extension/manifest.json': '{"version":"4.1.0"}',
      'extension/dist/background.js': '//',
      'server/index.ts': '//',
    });
    const { pullExtension } = await import('../../src/profiles/extension-source');
    await pullExtension('v4.1.0');
    expect(JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8')).version).toBe('4.1.0');
    expect(fs.existsSync(path.join(extDir, 'dist', 'background.js'))).toBe(true);
    expect(fs.existsSync(path.join(extDir, 'extension'))).toBe(false);
    expect(fs.existsSync(path.join(extDir, 'server'))).toBe(false);
    expect(fs.readdirSync(path.join(home, '.supersurf'))).toEqual(['extension']);
  });

  it('keeps the old cache when the tarball has no extension/manifest.json', async () => {
    served.tarball = makeTarball(home, { 'README.md': 'no extension here' });
    const { pullExtension } = await import('../../src/profiles/extension-source');
    await expect(pullExtension('v4.1.0')).rejects.toThrow();
    expect(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8')).toBe('{"version":"4.0.0"}');
    expect(fs.readdirSync(path.join(home, '.supersurf'))).toEqual(['extension']);
  });

  it('keeps the old cache when the tarball is corrupt', async () => {
    served.tarball = path.join(home, 'bad.tar.gz');
    fs.writeFileSync(served.tarball, 'not a tarball');
    const { pullExtension } = await import('../../src/profiles/extension-source');
    await expect(pullExtension('v4.1.0')).rejects.toThrow();
    expect(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8')).toBe('{"version":"4.0.0"}');
  });
});
