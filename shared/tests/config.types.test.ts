import { describe, it, expectTypeOf } from 'vitest';
import type { Config, PartialConfig, ConfigSource } from '../config/types';

describe('config types', () => {
  it('Config has 5 top-level sections', () => {
    expectTypeOf<Config>().toHaveProperty('experiments');
    expectTypeOf<Config>().toHaveProperty('security');
    expectTypeOf<Config>().toHaveProperty('daemon');
    expectTypeOf<Config>().toHaveProperty('logging');
    expectTypeOf<Config>().toHaveProperty('tips');
  });

  it('PartialConfig allows any subset', () => {
    const p: PartialConfig = { daemon: { port: 1234 } };
    expectTypeOf(p).toMatchTypeOf<PartialConfig>();
  });

  it('ConfigSource enumerates 4 layers', () => {
    expectTypeOf<ConfigSource>().toEqualTypeOf<'cli' | 'env' | 'file' | 'default'>();
  });
});
