/**
 * The ONE config merge. CLI flag → env var → ~/.supersurf/config.json →
 * shared/config/defaults.ts.
 *
 * Extracted because `cli.ts` runs `program.parse()` as a top-level side effect
 * and therefore cannot be imported as a module — which is how the merge got
 * duplicated into `bin/playbook-cli.ts` in the first place. Every runner
 * (MCP server, playbook CLI, playbook script runner) imports this instead.
 *
 * @module backend-config
 */

import * as path from 'node:path';
import * as os from 'node:os';
import {
  ConfigService,
  loadJsonConfig,
  loadEnvConfig,
  type PartialConfig,
} from 'shared';
import type { BackendConfig } from './backend';

/** Translate parsed Commander options into a PartialConfig slice. */
export function cliToPartial(options: any): PartialConfig {
  const out: PartialConfig = {};
  if (options.port !== undefined) out.daemon = { port: Number(options.port) };
  if (
    options.debug === true ||
    options.debug === 'no_truncate' ||
    (typeof options.debug === 'string' && options.debug && options.debug !== 'false')
  ) {
    out.logging = { debug: options.debug === 'no_truncate' ? 'no_truncate' : 'truncate' };
  }
  if (options.disableSecureEval) out.security = { ...(out.security || {}), secure_eval: false };
  if (options.disablePlaybookEval) out.security = { ...(out.security || {}), playbook_eval: false };
  return out;
}

/** Resolve the config file path, honouring SUPERSURF_CONFIG_FILE. */
export function configFilePath(): string {
  return process.env.SUPERSURF_CONFIG_FILE
    || path.join(os.homedir(), '.supersurf', 'config.json');
}

/** Build a ConfigService merging CLI + env + file inputs. */
export function buildConfigService(
  cliOptions: any,
  onWarn?: (msg: string) => void,
): ConfigService {
  const { config: fileCfg, warnings: fileWarn } = loadJsonConfig(configFilePath());
  const { config: envCfg, warnings: envWarn } = loadEnvConfig(process.env);
  if (onWarn) for (const w of [...fileWarn, ...envWarn]) onWarn(w);
  return new ConfigService({
    cli: cliToPartial(cliOptions),
    env: envCfg,
    file: fileCfg,
    onWarn,
  });
}

/** Build a BackendConfig from a resolved ConfigService snapshot. */
export function backendConfigFrom(
  configService: ConfigService,
  version: string,
  showUpgradeNotice = false,
): BackendConfig {
  const c = configService.get();
  return {
    debug: !!c.logging.debug,
    port: c.daemon.port,
    server: { name: 'SuperSurf', version },
    enabledExperiments: Object.entries(c.experiments)
      .filter(([k, v]) => v && k !== 'profiles')
      .map(([k]) => k),
    configService,
    showUpgradeNotice,
  };
}
