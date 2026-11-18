/**
 * Per-connection config for a shim: main turns the `shim_register` handshake
 * into plain-object inputs (structured-clone safe), the worker builds the
 * `ConfigService` from them. Imports only `shared`, so both sides use it.
 *
 * @module engine-worker/shim-config
 */
import { ConfigService, loadEnvConfig, loadJsonConfig } from 'shared';
import type { PartialConfig } from 'shared';

/** What `open` carries; the daemon's `port` and `version` always win over anything the shim sent. */
export interface ShimConfigInputs {
  cli: PartialConfig;
  env: PartialConfig;
  file: PartialConfig;
  port: number;
  version: string;
}

/** The env names the shim may send (shim-wire section 1); the daemon drops every other name. */
const ENV_ALLOWLIST = [
  'SUPERSURF_DEBUG',
  'SUPERSURF_EXPERIMENTS',
  'SUPERSURF_DISABLE_SECURE_EVAL',
  'SUPERSURF_DISABLE_PLAYBOOK_EVAL',
  'SUPERSURF_MULTI_AGENT',
  'SUPERSURF_SCREENSHOT_OMIT_PATH',
];

/** Handshake fields this uses; `allow_unsandboxed_playbook` has no config leaf yet and is ignored. */
export interface ShimHandshakeConfig {
  flags?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

/** Same flag mapping as `server/src/backend-config.ts` `cliToPartial`. */
export function shimConfigInputs(
  hs: ShimHandshakeConfig,
  daemon: { configPath: string; port: number; version: string },
): ShimConfigInputs {
  const f = hs.flags ?? {};
  const cli: PartialConfig = {};
  if (f.debug === true) cli.logging = { debug: 'truncate' };
  if (f.disable_secure_eval === true) cli.security = { ...cli.security, secure_eval: false };
  if (f.disable_playbook_eval === true) cli.security = { ...cli.security, playbook_eval: false };
  if (f.multi_agent === true) cli.agents = { multi_agent: true };

  const rawEnv: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = hs.env?.[k];
    if (typeof v === 'string') rawEnv[k] = v;
  }
  return {
    cli,
    env: loadEnvConfig(rawEnv).config,
    file: loadJsonConfig(daemon.configPath).config,
    port: daemon.port,
    version: daemon.version,
  };
}

export function configServiceFrom(i: ShimConfigInputs): ConfigService {
  return new ConfigService({ cli: { ...i.cli, daemon: { port: i.port } }, env: i.env, file: i.file });
}

/** Enabled experiment names, without `profiles` (same as `backendConfigFrom`). */
export function enabledExperiments(i: ShimConfigInputs): string[] {
  return Object.entries(configServiceFrom(i).get().experiments)
    .filter(([k, v]) => v && k !== 'profiles')
    .map(([k]) => k);
}
