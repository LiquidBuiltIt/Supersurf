import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cliToPartial, buildConfigService, backendConfigFrom } from '../src/backend-config';

let dir: string;
// The ambient shell may export SUPERSURF_EXPERIMENTS; env beats the config
// file, so park it for the duration or the experiment assertions are a
// coin flip on whoever's machine runs the suite.
let savedExperiments: string | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
  process.env.SUPERSURF_CONFIG_FILE = path.join(dir, 'config.json');
  savedExperiments = process.env.SUPERSURF_EXPERIMENTS;
  delete process.env.SUPERSURF_EXPERIMENTS;
});
afterEach(() => {
  delete process.env.SUPERSURF_CONFIG_FILE;
  delete process.env.SUPERSURF_PORT;
  if (savedExperiments === undefined) delete process.env.SUPERSURF_EXPERIMENTS;
  else process.env.SUPERSURF_EXPERIMENTS = savedExperiments;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cliToPartial', () => {
  it('maps --port and --debug', () => {
    expect(cliToPartial({ port: '7000' })).toEqual({ daemon: { port: 7000 } });
    expect(cliToPartial({ debug: true })).toEqual({ logging: { debug: 'truncate' } });
    expect(cliToPartial({ debug: 'no_truncate' })).toEqual({ logging: { debug: 'no_truncate' } });
  });

  it('maps --disable-secure-eval to security.secure_eval false', () => {
    expect(cliToPartial({ disableSecureEval: true })).toEqual({ security: { secure_eval: false } });
  });

  it('maps --disable-playbook-eval to security.playbook_eval false', () => {
    expect(cliToPartial({ disablePlaybookEval: true })).toEqual({ security: { playbook_eval: false } });
  });

  it('keeps both eval flags when both are passed', () => {
    expect(cliToPartial({ disableSecureEval: true, disablePlaybookEval: true }))
      .toEqual({ security: { secure_eval: false, playbook_eval: false } });
  });
});

describe('buildConfigService', () => {
  it('honours the CLI flag over the config file', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ daemon: { port: 6000 } }));
    const svc = buildConfigService({ port: '7000' });
    expect(svc.get().daemon.port).toBe(7000);
    expect(svc.sourceOf('daemon.port')).toBe('cli');
  });

  it('honours the env var over the config file', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ daemon: { port: 6000 } }));
    process.env.SUPERSURF_PORT = '6500';
    expect(buildConfigService({}).get().daemon.port).toBe(6500);
  });

  it('falls back to the config file when there is no CLI or env input', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ daemon: { port: 6000 } }));
    expect(buildConfigService({}).get().daemon.port).toBe(6000);
  });
});

describe('backendConfigFrom', () => {
  it('builds the same shape both runners used to build by hand', () => {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ experiments: { fingerprinting: true, page_diffing: false } }),
    );
    const cfg = backendConfigFrom(buildConfigService({}), '9.9.9', false);
    expect(cfg.server).toEqual({ name: 'SuperSurf', version: '9.9.9' });
    expect(cfg.port).toBe(5555);
    expect(cfg.debug).toBe(false);
    expect(cfg.enabledExperiments).toEqual(['fingerprinting']);
    expect(cfg.showUpgradeNotice).toBe(false);
    expect(cfg.configService).toBeDefined();
  });
});
