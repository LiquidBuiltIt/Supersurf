import type { Config, PartialConfig, ConfigSource } from './types';
import type { DebugMode } from '../logger/logger';
import { HARDCODED_DEFAULTS } from './defaults';

export interface ConfigInputs {
  cli: PartialConfig;
  env: PartialConfig;
  file: PartialConfig;
  onWarn?: (msg: string) => void;
}

type LeafPath = string;

export class ConfigService {
  private resolved: Config;
  private sources: Map<LeafPath, ConfigSource> = new Map();

  constructor(inputs: ConfigInputs) {
    const warn = inputs.onWarn ?? (() => {});
    this.validateKnownKeys(inputs.file, warn);
    this.resolved = this.merge(inputs, warn);
  }

  get(): Config {
    return this.resolved;
  }

  sourceOf(path: LeafPath): ConfigSource {
    return this.sources.get(path) ?? 'default';
  }

  private validateKnownKeys(file: PartialConfig, warn: (m: string) => void) {
    const known = new Set(Object.keys(HARDCODED_DEFAULTS));
    for (const k of Object.keys(file)) {
      if (!known.has(k)) warn(`config: unknown top-level key "${k}" — ignored`);
    }
  }

  private pick<T>(
    leafPath: LeafPath,
    cli: T | undefined,
    env: T | undefined,
    file: T | undefined,
    fallback: T,
    typeCheck: (v: unknown) => v is T,
    warn: (m: string) => void,
  ): T {
    const check = (v: T | undefined, src: ConfigSource): T | undefined => {
      if (v === undefined) return undefined;
      if (!typeCheck(v)) {
        warn(`config: ${leafPath} from ${src} has wrong type — falling back`);
        return undefined;
      }
      this.sources.set(leafPath, src);
      return v;
    };
    const fromCli = check(cli, 'cli');
    if (fromCli !== undefined) return fromCli;
    const fromEnv = check(env, 'env');
    if (fromEnv !== undefined) return fromEnv;
    const fromFile = check(file, 'file');
    if (fromFile !== undefined) return fromFile;
    this.sources.set(leafPath, 'default');
    return fallback;
  }

  private merge(inp: ConfigInputs, warn: (m: string) => void): Config {
    const D = HARDCODED_DEFAULTS;
    const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
    const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const isStrArr = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((x) => typeof x === 'string');
    const isMode = (v: unknown): v is 'tranco' | 'custom' | 'both' =>
      v === 'tranco' || v === 'custom' || v === 'both';
    const isDebugMode = (v: unknown): v is DebugMode =>
      v === false || v === 'truncate' || v === 'no_truncate';

    const pick = this.pick.bind(this);

    return {
      experiments: {
        page_diffing: pick('experiments.page_diffing',
          inp.cli.experiments?.page_diffing, inp.env.experiments?.page_diffing,
          inp.file.experiments?.page_diffing, D.experiments.page_diffing, isBool, warn),
        smart_waiting: pick('experiments.smart_waiting',
          inp.cli.experiments?.smart_waiting, inp.env.experiments?.smart_waiting,
          inp.file.experiments?.smart_waiting, D.experiments.smart_waiting, isBool, warn),
        storage_inspection: pick('experiments.storage_inspection',
          inp.cli.experiments?.storage_inspection, inp.env.experiments?.storage_inspection,
          inp.file.experiments?.storage_inspection, D.experiments.storage_inspection, isBool, warn),
        mouse_humanization: pick('experiments.mouse_humanization',
          inp.cli.experiments?.mouse_humanization, inp.env.experiments?.mouse_humanization,
          inp.file.experiments?.mouse_humanization, D.experiments.mouse_humanization, isBool, warn),
      },
      security: {
        secure_eval: pick('security.secure_eval',
          inp.cli.security?.secure_eval, inp.env.security?.secure_eval,
          inp.file.security?.secure_eval, D.security.secure_eval, isBool, warn),
        domain_whitelist: {
          enabled: pick('security.domain_whitelist.enabled',
            inp.cli.security?.domain_whitelist?.enabled,
            inp.env.security?.domain_whitelist?.enabled,
            inp.file.security?.domain_whitelist?.enabled,
            D.security.domain_whitelist.enabled, isBool, warn),
          mode: pick('security.domain_whitelist.mode',
            inp.cli.security?.domain_whitelist?.mode,
            inp.env.security?.domain_whitelist?.mode,
            inp.file.security?.domain_whitelist?.mode,
            D.security.domain_whitelist.mode, isMode, warn),
          custom: pick('security.domain_whitelist.custom',
            inp.cli.security?.domain_whitelist?.custom,
            inp.env.security?.domain_whitelist?.custom,
            inp.file.security?.domain_whitelist?.custom,
            D.security.domain_whitelist.custom, isStrArr, warn),
        },
      },
      daemon: {
        port: pick('daemon.port',
          inp.cli.daemon?.port, inp.env.daemon?.port,
          inp.file.daemon?.port, D.daemon.port, isNum, warn),
        idle_timeout_ms: pick('daemon.idle_timeout_ms',
          inp.cli.daemon?.idle_timeout_ms, inp.env.daemon?.idle_timeout_ms,
          inp.file.daemon?.idle_timeout_ms, D.daemon.idle_timeout_ms, isNum, warn),
      },
      logging: {
        debug: pick('logging.debug',
          inp.cli.logging?.debug, inp.env.logging?.debug,
          inp.file.logging?.debug, D.logging.debug, isDebugMode, warn),
        usage_metrics: pick('logging.usage_metrics',
          inp.cli.logging?.usage_metrics, inp.env.logging?.usage_metrics,
          inp.file.logging?.usage_metrics, D.logging.usage_metrics, isBool, warn),
      },
      tips: pick('tips', inp.cli.tips, inp.env.tips, inp.file.tips, D.tips, isBool, warn),
    };
  }
}
