import { describe, it, expect } from 'vitest';
import { loadEnvConfig } from '../config/loaders';

describe('loadEnvConfig', () => {
  it('returns empty when no SUPERSURF_* vars set', () => {
    const { config, warnings } = loadEnvConfig({});
    expect(config).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('maps SUPERSURF_PORT to daemon.port', () => {
    const { config } = loadEnvConfig({ SUPERSURF_PORT: '8080' });
    expect(config.daemon?.port).toBe(8080);
  });

  it('warns + skips when SUPERSURF_PORT is not numeric', () => {
    const { config, warnings } = loadEnvConfig({ SUPERSURF_PORT: 'abc' });
    expect(config.daemon?.port).toBeUndefined();
    expect(warnings[0]).toMatch(/SUPERSURF_PORT/);
  });

  it('maps SUPERSURF_DISABLE_SECURE_EVAL=1 to security.secure_eval=false', () => {
    const { config } = loadEnvConfig({ SUPERSURF_DISABLE_SECURE_EVAL: '1' });
    expect(config.security?.secure_eval).toBe(false);
  });

  it('maps SUPERSURF_DEBUG=1 to logging.debug=truncate', () => {
    const { config } = loadEnvConfig({ SUPERSURF_DEBUG: '1' });
    expect(config.logging?.debug).toBe('truncate');
  });

  it('maps SUPERSURF_DEBUG=no_truncate to logging.debug=no_truncate', () => {
    const { config } = loadEnvConfig({ SUPERSURF_DEBUG: 'no_truncate' });
    expect(config.logging?.debug).toBe('no_truncate');
  });

  it('SUPERSURF_DEBUG=0 leaves config.logging undefined', () => {
    const { config } = loadEnvConfig({ SUPERSURF_DEBUG: '0' });
    expect(config.logging).toBeUndefined();
  });

  it('parses SUPERSURF_EXPERIMENTS comma list', () => {
    const { config } = loadEnvConfig({
      SUPERSURF_EXPERIMENTS: 'page_diffing,smart_waiting',
    });
    expect(config.experiments?.page_diffing).toBe(true);
    expect(config.experiments?.smart_waiting).toBe(true);
    expect(config.experiments?.mouse_humanization).toBeUndefined();
  });

  it('warns on unknown experiment names but accepts known ones', () => {
    const { config, warnings } = loadEnvConfig({
      SUPERSURF_EXPERIMENTS: 'page_diffing,bogus,smart_waiting',
    });
    expect(config.experiments?.page_diffing).toBe(true);
    expect(config.experiments?.smart_waiting).toBe(true);
    expect(warnings[0]).toMatch(/bogus/);
  });

  it('SUPERSURF_EXPERIMENTS=profiles sets experiments.profiles=true without warnings', () => {
    const { config, warnings } = loadEnvConfig({
      SUPERSURF_EXPERIMENTS: 'profiles',
    });
    expect(config.experiments?.profiles).toBe(true);
    expect(warnings).toEqual([]);
  });
});
