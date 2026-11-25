import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { findShimBinary } from 'shared';
import { relayDecision } from '../src/relay';
import { makeRig } from './helpers/relay-rig';

vi.mock('shared', async (orig) => ({ ...(await orig<typeof import('shared')>()), findShimBinary: vi.fn(() => null) }));

describe('relayDecision shim lookup root', () => {
  const rig = makeRig();
  afterEach(() => rig.cleanup());

  it('looks in its own package (supersurf-mcp), where the release binaries ship', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.SUPERSURF_CONFIG_FILE = rig.config;
    await relayDecision({ disableLegacyServer: true, port: 6001 }, []);
    const root = vi.mocked(findShimBinary).mock.calls[0][0]!;
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name).toBe('supersurf-mcp');
  });
});
