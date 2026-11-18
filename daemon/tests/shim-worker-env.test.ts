import { describe, it, expect, vi, afterEach } from 'vitest';

const ctor = vi.hoisted(() => vi.fn());
vi.mock('worker_threads', async (orig) => ({
  ...(await orig<typeof import('worker_threads')>()),
  Worker: class { constructor(...args: unknown[]) { ctor(...args); } },
}));

import { startEngineWorker } from '../src/shim-server';

afterEach(() => { vi.unstubAllEnvs(); ctor.mockClear(); });

describe('production worker factory', () => {
  it('starts the Worker with the scrubbed env, not the daemon\'s own', () => {
    vi.stubEnv('SUPERSURF_DEBUG', '1');
    vi.stubEnv('SUPERSURF_DISABLE_SECURE_EVAL', '1');
    vi.stubEnv('SUPERSURF_CONFIG_FILE', '/etc/evil.json');
    startEngineWorker();
    expect(ctor).toHaveBeenCalledTimes(1);
    const opts = ctor.mock.calls[0][1] as { env: NodeJS.ProcessEnv };
    expect(opts.env).toBeDefined();
    expect(opts.env.SUPERSURF_DEBUG).toBeUndefined();
    expect(opts.env.SUPERSURF_DISABLE_SECURE_EVAL).toBeUndefined();
    expect(opts.env.SUPERSURF_CONFIG_FILE).toBeUndefined();
    expect(opts.env.PATH).toBe(process.env.PATH);
  });
});
