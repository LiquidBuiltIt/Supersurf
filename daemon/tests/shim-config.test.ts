import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shimConfigInputs, configServiceFrom, enabledExperiments } from '../src/engine-worker/shim-config';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-config-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const configPath = path.join(dir, 'config.json');
const base = { configPath, port: 5599, version: '9.9.9-test' };

describe('shimConfigInputs', () => {
  it('maps flags to the cli partial', () => {
    const i = shimConfigInputs({ flags: { debug: true, disable_secure_eval: true, disable_playbook_eval: true, multi_agent: true, allow_unsandboxed_playbook: true } }, base);
    expect(i.cli).toEqual({
      logging: { debug: 'truncate' },
      security: { secure_eval: false, playbook_eval: false },
      agents: { multi_agent: true },
    });
    expect(i.port).toBe(5599);
    expect(i.version).toBe('9.9.9-test');
  });

  it('false or missing flags map to nothing', () => {
    expect(shimConfigInputs({ flags: { debug: false, multi_agent: false } }, base).cli).toEqual({});
    expect(shimConfigInputs({}, base).cli).toEqual({});
  });

  it('keeps the six allowlisted env names and drops SUPERSURF_CONFIG_FILE, SUPERSURF_PORT and the rest', () => {
    const i = shimConfigInputs({
      env: {
        SUPERSURF_DEBUG: '1', SUPERSURF_EXPERIMENTS: 'page_diffing', SUPERSURF_MULTI_AGENT: 'true',
        SUPERSURF_CONFIG_FILE: '/etc/evil.json', SUPERSURF_PORT: '1234', SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK: '1', PATH: '/x',
      },
    }, base);
    expect(i.env.agents).toEqual({ multi_agent: true });
    expect(i.env.logging).toEqual({ debug: 'truncate' });
    expect(i.env.daemon).toBeUndefined();
    expect(i.file).toEqual({});
  });

  it('ignores non-string env values', () => {
    expect(shimConfigInputs({ env: { SUPERSURF_DEBUG: 1 as any } }, base).env).toEqual({});
  });

  it('reads the daemon config file', () => {
    fs.writeFileSync(configPath, JSON.stringify({ experiments: { fingerprinting: true } }));
    const i = shimConfigInputs({}, base);
    expect(i.file).toEqual({ experiments: { fingerprinting: true } });
    fs.rmSync(configPath);
  });
});

describe('configServiceFrom / enabledExperiments', () => {
  it('daemon port wins over a port in the file', () => {
    const i = { ...shimConfigInputs({}, base), file: { daemon: { port: 1 } } as any };
    expect(configServiceFrom(i).get().daemon.port).toBe(5599);
  });

  it('lists enabled experiments from env and file, not profiles', () => {
    const i = shimConfigInputs({ env: { SUPERSURF_EXPERIMENTS: 'page_diffing' } }, base);
    i.file = { experiments: { fingerprinting: true } } as any;
    expect(enabledExperiments(i).sort()).toEqual(['fingerprinting', 'page_diffing']);
  });

  it('is empty by default', () => {
    expect(enabledExperiments(shimConfigInputs({}, base))).toEqual([]);
  });
});
