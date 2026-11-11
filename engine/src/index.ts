/**
 * Engine barrel: the only surface `supersurf-mcp` uses.
 *
 * `getRegistry` and `getLogger` are re-exported from the engine's OWN copy of
 * `shared`. In the published layout the server and the daemon each carry a
 * bundled `shared`; the log registry is a singleton per copy, so the host must
 * configure the one the engine logs through.
 *
 * @module engine
 */
import type { RunRunOpts } from './playbooks/run-cli';

export { AgentSessionManager } from './agent-session-manager';
export { startScriptMode } from './stdio';
export { loadDotenv } from './dotenv';
export { setSkillsInstalled } from './tips';
export { detectPluginSkills } from './plugin-detect';
export { getRegistry, getLogger } from 'shared';
export type { BackendConfig } from './backend/types';
export type { EngineHost } from './host';
export type { RunRunOpts } from './playbooks/run-cli';

/**
 * Lazy on purpose: `playbooks/run-cli` reaches the runner, the sandbox host and
 * the experiment registry. An MCP start must not pay for a subcommand it never
 * invokes.
 */
export async function runPlaybookCli(
  name: string,
  flags: { param?: string[]; profile?: string; json?: boolean },
  opts: RunRunOpts,
): Promise<number> {
  const { runRun } = await import('./playbooks/run-cli');
  return runRun(name, flags, opts);
}
