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
import { ConfigService, type PartialConfig } from 'shared';
import type { BackendConfig } from './backend';
/** Translate parsed Commander options into a PartialConfig slice. */
export declare function cliToPartial(options: any): PartialConfig;
/** Resolve the config file path, honouring SUPERSURF_CONFIG_FILE. */
export declare function configFilePath(): string;
/** Build a ConfigService merging CLI + env + file inputs. */
export declare function buildConfigService(cliOptions: any, onWarn?: (msg: string) => void): ConfigService;
/** Build a BackendConfig from a resolved ConfigService snapshot. */
export declare function backendConfigFrom(configService: ConfigService, version: string, showUpgradeNotice?: boolean): BackendConfig;
//# sourceMappingURL=backend-config.d.ts.map