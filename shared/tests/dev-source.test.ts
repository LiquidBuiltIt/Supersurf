import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { devSource } from '../dev-source';

function fakeRepo(name = 'supersurf'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-source-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }));
  for (const f of ['server/dist/cli.js', 'daemon/dist/main.js', 'extension/manifest.json']) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), '');
  }
  return root;
}

describe('devSource', () => {
  let err: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  const argv1 = process.argv[1];

  beforeEach(() => {
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.SUPERSURF_DEV_ENVIRONMENT;
    process.argv[1] = argv1;
    vi.restoreAllMocks();
  });

  it('returns null and stays silent when the var is unset', () => {
    expect(devSource('server')).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });

  it('treats an empty string as unset', () => {
    process.env.SUPERSURF_DEV_ENVIRONMENT = '';
    expect(devSource('daemon')).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });

  it('routes each component into a valid clone', () => {
    const root = fakeRepo();
    process.env.SUPERSURF_DEV_ENVIRONMENT = root;
    expect(devSource('server')).toBe(path.join(root, 'server/dist/cli.js'));
    expect(devSource('daemon')).toBe(path.join(root, 'daemon/dist/main.js'));
    expect(devSource('extension')).toBe(path.join(root, 'extension'));
    expect(err).not.toHaveBeenCalled();
  });

  it('accepts a root with a trailing slash', () => {
    const root = fakeRepo();
    process.env.SUPERSURF_DEV_ENVIRONMENT = root + '/';
    expect(devSource('server')).toBe(path.join(root, 'server/dist/cli.js'));
  });

  it('falls back when the root is not a SuperSurf repo, on stderr only', () => {
    process.env.SUPERSURF_DEV_ENVIRONMENT = fakeRepo('something-else');
    expect(devSource('server')).toBeNull();
    expect(err.mock.calls[0][0]).toContain('not a SuperSurf repo root');
    expect(err.mock.calls[0][0]).toContain('Using the packaged server instead');
    expect(log).not.toHaveBeenCalled();
  });

  it('falls back when the root has no package.json', () => {
    process.env.SUPERSURF_DEV_ENVIRONMENT = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-source-'));
    expect(devSource('daemon')).toBeNull();
    expect(err.mock.calls[0][0]).toContain('not a SuperSurf repo root');
  });

  it('falls back and says to build when the target is missing', () => {
    const root = fakeRepo();
    fs.rmSync(path.join(root, 'daemon/dist'), { recursive: true });
    fs.rmSync(path.join(root, 'extension/manifest.json'));
    process.env.SUPERSURF_DEV_ENVIRONMENT = root;
    expect(devSource('daemon')).toBeNull();
    expect(err.mock.calls[0][0]).toContain('npm run build');
    expect(devSource('extension')).toBeNull();
    expect(err.mock.calls[1][0]).toContain('extension/manifest.json');
    expect(log).not.toHaveBeenCalled();
  });

  it('never routes a process to the file it is already running', () => {
    const root = fakeRepo();
    process.env.SUPERSURF_DEV_ENVIRONMENT = root;
    process.argv[1] = path.join(root, 'daemon/dist/main.js');
    expect(devSource('daemon')).toBeNull();
    expect(devSource('server')).toBe(path.join(root, 'server/dist/cli.js'));
  });
});
