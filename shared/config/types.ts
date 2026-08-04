import type { DebugMode } from '../logger/logger';

/** When `browser_take_screenshot` omits `path`. Explicit `path` always saves to that file. */
export type ScreenshotOmitPathMode = 'inline' | 'path' | 'both';

export interface Config {
  experiments: {
    page_diffing: boolean;
    smart_waiting: boolean;
    storage_inspection: boolean;
    mouse_humanization: boolean;
    fingerprinting: boolean;
  };
  security: {
    secure_eval: boolean;
    domain_whitelist: {
      enabled: boolean;
      mode: 'tranco' | 'custom' | 'both';
      custom: string[];
    };
  };
  daemon: {
    port: number;
    idle_timeout_ms: number;
  };
  logging: {
    debug: DebugMode;
    usage_metrics: boolean;
  };
  profiles: {
    /** Absolute path to Chrome/Chromium binary, or null to auto-detect. */
    chrome_path: string | null;
    startup_opts: {
      disable_gpu: boolean;
    };
  };
  /**
   * Screenshot tool defaults.
   * `omit_path`: what to return when the agent omits `path` —
   * `inline` (default, current contract), `path` (temp file under OS tmpdir, text only),
   * or `both` (temp file + inline image).
   */
  screenshot: {
    omit_path: ScreenshotOmitPathMode;
  };
  tips: boolean;
}

export type PartialConfig = {
  experiments?: Partial<Config['experiments']>;
  security?: {
    secure_eval?: boolean;
    domain_whitelist?: Partial<Config['security']['domain_whitelist']>;
  };
  daemon?: Partial<Config['daemon']>;
  logging?: Partial<Config['logging']>;
  profiles?: {
    chrome_path?: string | null;
    startup_opts?: Partial<Config['profiles']['startup_opts']>;
  };
  screenshot?: Partial<Config['screenshot']>;
  tips?: boolean;
};

export type ConfigSource = 'cli' | 'env' | 'file' | 'default';
