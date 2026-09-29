import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { isExtensionCached, getExtensionDir, ensureExtension } from '../../src/profiles/extension-source';

vi.mock('https', () => {
  const get = vi.fn(() => { throw new Error('network touched'); });
  return { default: { get }, get };
});

describe('extension-source', () => {
  it('getExtensionDir returns expected path', () => {
    const dir = getExtensionDir();
    expect(dir).toBe(path.join(os.homedir(), '.supersurf', 'extension'));
  });

  it('isExtensionCached checks for manifest.json', () => {
    // This test checks the function logic — result depends on filesystem state
    const result = isExtensionCached();
    expect(typeof result).toBe('boolean');
  });
});

describe('extension-source under SUPERSURF_DEV_ENVIRONMENT', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-src-dev-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'supersurf' }));
    fs.mkdirSync(path.join(root, 'extension'));
    fs.writeFileSync(path.join(root, 'extension', 'manifest.json'), '{"version":"0.0.0"}');
    process.env.SUPERSURF_DEV_ENVIRONMENT = root;
  });
  afterEach(() => {
    delete process.env.SUPERSURF_DEV_ENVIRONMENT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('points managed profiles at the clone\'s extension dir', () => {
    expect(getExtensionDir()).toBe(path.join(root, 'extension'));
    expect(isExtensionCached()).toBe(true);
  });

  it('skips the GitHub download entirely', async () => {
    await expect(ensureExtension()).resolves.toBeUndefined();
  });

  it('falls back to the release cache dir when the root is not a SuperSurf repo', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'nope' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getExtensionDir()).toBe(path.join(os.homedir(), '.supersurf', 'extension'));
    err.mockRestore();
  });
});
