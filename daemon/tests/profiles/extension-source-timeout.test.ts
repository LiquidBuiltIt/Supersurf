import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

// A request that never gets a response. Like Node, it emits 'timeout' after
// opts.timeout ms of socket idleness, and destroy(err) emits 'error' with err.
const requests: EventEmitter[] = [];
vi.mock('https', () => {
  const get = vi.fn((_url: string, opts: any) => {
    const req: any = new EventEmitter();
    req.destroy = (err?: Error) => { if (err) req.emit('error', err); };
    if (opts && typeof opts === 'object' && opts.timeout) {
      setTimeout(() => req.emit('timeout'), opts.timeout);
    }
    requests.push(req);
    return req;
  });
  return { default: { get }, get };
});

describe('extension-source network timeouts', () => {
  let home: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    vi.useFakeTimers();
    requests.length = 0;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-timeout-'));
    process.env.HOME = home;
    const extDir = path.join(home, '.supersurf', 'extension');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, 'manifest.json'), '{"version":"4.0.0"}');
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('getLatestTag rejects when the tags request stalls', async () => {
    const { getLatestTag } = await import('../../src/profiles/extension-source');
    const p = getLatestTag();
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('pullExtension rejects when the download stalls and leaves the cache intact', async () => {
    const { pullExtension } = await import('../../src/profiles/extension-source');
    const p = pullExtension('v4.1.0');
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fs.readdirSync(path.join(home, '.supersurf'))).toEqual(['extension']);
  });

  it('ensureExtension resolves with a cached extension when the update check stalls', async () => {
    const { ensureExtension } = await import('../../src/profiles/extension-source');
    const p = ensureExtension();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).resolves.toBeUndefined();
    expect(requests.length).toBe(1);
  });
});
