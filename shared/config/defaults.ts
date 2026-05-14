import type { Config } from './types';

export const HARDCODED_DEFAULTS: Config = {
  experiments: {
    page_diffing: false,
    smart_waiting: false,
    storage_inspection: false,
    mouse_humanization: false,
    profiles: false,
  },
  security: {
    secure_eval: true,
    domain_whitelist: {
      enabled: false,
      mode: 'tranco',
      custom: [],
    },
  },
  daemon: {
    port: 5555,
    idle_timeout_ms: 10 * 60 * 1000,
  },
  logging: {
    debug: false,
    usage_metrics: false,
  },
  tips: true,
};

export const SCAFFOLD_DEFAULTS: Config = {
  ...HARDCODED_DEFAULTS,
  experiments: { ...HARDCODED_DEFAULTS.experiments },
  security: {
    ...HARDCODED_DEFAULTS.security,
    domain_whitelist: { ...HARDCODED_DEFAULTS.security.domain_whitelist, custom: [] },
  },
  daemon: { ...HARDCODED_DEFAULTS.daemon },
  logging: { ...HARDCODED_DEFAULTS.logging, usage_metrics: true },
};
