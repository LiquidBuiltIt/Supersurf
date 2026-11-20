import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { relayDecision } from '../src/relay';
import { makeRig, type Rig } from './helpers/relay-rig';

let rig: Rig;
let err: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};
const KEYS = ['SUPERSURF_SHIM_BIN', 'SUPERSURF_CONFIG_FILE', 'SUPERSURF_RELAY', 'SUPERSURF_PORT'];

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  rig = makeRig();
  process.env.SUPERSURF_CONFIG_FILE = rig.config;
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
  rig.cleanup();
});

describe('relayDecision', () => {
  it('off: null, no exec, no output, even with a binary and a malformed config', async () => {
    process.env.SUPERSURF_SHIM_BIN = rig.recorder().bin;
    fs.writeFileSync(rig.config, '{nope');
    const exec = vi.fn();
    expect(await relayDecision({}, [], exec)).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  it('on with a binary: execs it with shimArgs and returns its code', async () => {
    const rec = rig.recorder();
    process.env.SUPERSURF_SHIM_BIN = rec.bin;
    const exec = vi.fn().mockResolvedValue(7);
    expect(await relayDecision({ relay: true, port: 6001 }, ['--multi-agent', '--log-file', 'x'], exec)).toBe(7);
    expect(exec).toHaveBeenCalledWith(rec.bin, ['--port', '6001', '--multi-agent']);
    expect(err).not.toHaveBeenCalled();
  });

  it('on: an exec rejection warns once and returns null', async () => {
    process.env.SUPERSURF_SHIM_BIN = rig.recorder().bin;
    const exec = vi.fn().mockRejectedValue(new Error('boom'));
    expect(await relayDecision({ relay: true }, [], exec)).toBeNull();
    expect(err.mock.calls).toEqual([['[supersurf] could not hand over to supersurf-shim: boom; running the Node server.']]);
  });

  it('on: a binary that fails its --version probe never reaches exec', async () => {
    const bin = path.join(rig.home, 'bad');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    process.env.SUPERSURF_SHIM_BIN = bin;
    const exec = vi.fn();
    expect(await relayDecision({ relay: true }, [], exec)).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
  });
});
