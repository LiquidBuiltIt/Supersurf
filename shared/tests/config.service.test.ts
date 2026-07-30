import { describe, it, expect } from 'vitest';
import { ConfigService } from '../config/service';
import { HARDCODED_DEFAULTS } from '../config/defaults';

describe('ConfigService', () => {
  it('returns hardcoded defaults when no overrides', () => {
    const s = new ConfigService({ cli: {}, env: {}, file: {} });
    expect(s.get()).toEqual(HARDCODED_DEFAULTS);
  });

  it('file overrides default', () => {
    const s = new ConfigService({ cli: {}, env: {}, file: { daemon: { port: 7000 } } });
    expect(s.get().daemon.port).toBe(7000);
    expect(s.get().daemon.idle_timeout_ms).toBe(HARDCODED_DEFAULTS.daemon.idle_timeout_ms);
  });

  it('env overrides file', () => {
    const s = new ConfigService({
      cli: {},
      env: { daemon: { port: 8000 } },
      file: { daemon: { port: 7000 } },
    });
    expect(s.get().daemon.port).toBe(8000);
  });

  it('cli overrides env', () => {
    const s = new ConfigService({
      cli: { daemon: { port: 9000 } },
      env: { daemon: { port: 8000 } },
      file: { daemon: { port: 7000 } },
    });
    expect(s.get().daemon.port).toBe(9000);
  });

  it('partial sections fall through per leaf', () => {
    const s = new ConfigService({
      cli: {},
      env: { logging: { debug: 'truncate' } },
      file: { logging: { usage_metrics: true } },
    });
    expect(s.get().logging.debug).toBe('truncate');
    expect(s.get().logging.usage_metrics).toBe(true);
  });

  it('usage_metrics defaults to false and is source-tracked', () => {
    const s = new ConfigService({ cli: {}, env: {}, file: {} });
    expect(s.get().logging.usage_metrics).toBe(false);
    expect(s.sourceOf('logging.usage_metrics')).toBe('default');
  });

  it('usage_metrics can be enabled via file layer', () => {
    const s = new ConfigService({ cli: {}, env: {}, file: { logging: { usage_metrics: true } } });
    expect(s.get().logging.usage_metrics).toBe(true);
    expect(s.sourceOf('logging.usage_metrics')).toBe('file');
  });

  it('reports source for each leaf', () => {
    const s = new ConfigService({
      cli: { daemon: { port: 9000 } },
      env: { logging: { debug: 'truncate' } },
      file: { security: { secure_eval: false } },
    });
    expect(s.sourceOf('daemon.port')).toBe('cli');
    expect(s.sourceOf('logging.debug')).toBe('env');
    expect(s.sourceOf('security.secure_eval')).toBe('file');
    expect(s.sourceOf('tips')).toBe('default');
  });

  it('warns on unknown top-level key in file', () => {
    const warns: string[] = [];
    const s = new ConfigService({
      cli: {},
      env: {},
      file: { bogus: 1 } as any,
      onWarn: (m) => warns.push(m),
    });
    expect(warns[0]).toMatch(/bogus/);
    expect(s.get()).toEqual(HARDCODED_DEFAULTS);
  });

  it('profiles.chrome_path defaults to null (auto-detect)', () => {
    const s = new ConfigService({ cli: {}, env: {}, file: {} });
    expect(s.get().profiles.chrome_path).toBeNull();
    expect(s.sourceOf('profiles.chrome_path')).toBe('default');
  });

  it('profiles.chrome_path can be set via file', () => {
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const s = new ConfigService({
      cli: {},
      env: {},
      file: { profiles: { chrome_path: chromePath } },
    });
    expect(s.get().profiles.chrome_path).toBe(chromePath);
    expect(s.sourceOf('profiles.chrome_path')).toBe('file');
  });

  it('profiles.chrome_path rejects non-string with warning', () => {
    const warns: string[] = [];
    const s = new ConfigService({
      cli: {},
      env: {},
      file: { profiles: { chrome_path: 123 as any } },
      onWarn: (m) => warns.push(m),
    });
    expect(s.get().profiles.chrome_path).toBeNull();
    expect(warns.some((w) => w.includes('profiles.chrome_path'))).toBe(true);
  });

  it('warns on wrong type and falls back to default', () => {
    const warns: string[] = [];
    const s = new ConfigService({
      cli: {},
      env: {},
      file: { daemon: { port: 'abc' as any } },
      onWarn: (m) => warns.push(m),
    });
    expect(warns[0]).toMatch(/daemon\.port/);
    expect(s.get().daemon.port).toBe(HARDCODED_DEFAULTS.daemon.port);
  });
});
