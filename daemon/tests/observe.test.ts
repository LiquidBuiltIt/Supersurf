import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawn = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })));
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawn }));
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>();
  return { ...real, default: { ...real, existsSync: () => true } };
});

import { observe } from '../src/cli-commands';

describe('observe', () => {
  beforeEach(() => { spawn.mockClear(); vi.spyOn(console, 'log').mockImplementation(() => {}); });

  it('tails with -F so it follows daemon.log across rotation', () => {
    observe();
    expect(spawn).toHaveBeenCalledWith('tail', ['-F', expect.stringContaining('daemon.log')], expect.anything());
  });
});
