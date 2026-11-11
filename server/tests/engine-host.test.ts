import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngineHost } from '../src/engine-host';
import { openSocketLink } from '../src/socket-link';

let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-host-'));
  saved = process.env.SUPERSURF_CONFIG_FILE;
  process.env.SUPERSURF_CONFIG_FILE = path.join(dir, 'config.json');
});
afterEach(() => {
  if (saved === undefined) delete process.env.SUPERSURF_CONFIG_FILE;
  else process.env.SUPERSURF_CONFIG_FILE = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createEngineHost', () => {
  it('carries the version it was given', () => {
    expect(createEngineHost('9.9.9').packageVersion).toBe('9.9.9');
  });

  it('opens links through openSocketLink', () => {
    expect(createEngineHost('9.9.9').openLink).toBe(openSocketLink);
  });

  it('runConfig builds a BackendConfig whose server version is the host version', () => {
    const cfg = createEngineHost('9.9.9').runConfig();
    expect(cfg.server).toEqual({ name: 'SuperSurf', version: '9.9.9' });
    expect(typeof cfg.port).toBe('number');
  });
});
