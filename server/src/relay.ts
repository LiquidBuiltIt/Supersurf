/**
 * The `agents.relay` decision for the `supersurf-mcp` bin: hand this process's stdio to
 * `supersurf-shim` (execve where Node has it), or return and let today's Node server run.
 * Off prints nothing. Nothing is read from stdin before the decision.
 *
 * @module relay
 */
import * as path from 'node:path';
import { findShimBinary, probeShim, shimArgs, execReplace } from 'shared';
import { buildConfigService } from './backend-config';

/**
 * @param options parsed Commander options
 * @param args    the argv after the node/script pair, with the legacy leading `mcp` already dropped
 * @returns the shim's exit code when it ran (the caller exits with it), or `null` to run the Node server
 */
export async function relayDecision(options: any, args: string[], exec: typeof execReplace = execReplace): Promise<number | null> {
  const cfg = buildConfigService(options).get(); // no onWarn: `main` still prints its warnings once
  if (!cfg.agents.relay) return null;

  let root: string | undefined;
  try { root = path.dirname(require.resolve('supersurf-daemon/package.json')); } catch { /* no daemon package: env only */ }
  const bin = findShimBinary(root);
  if (!bin) {
    console.error('[supersurf] agents.relay is on but supersurf-shim was not found (set SUPERSURF_SHIM_BIN, or install a SuperSurf build that ships it); running the Node server.');
    return null;
  }
  try {
    probeShim(bin); // a failed process.execve aborts the process, so prove the binary runs first
    return await exec(bin, shimArgs(args, cfg.daemon.port));
  } catch (err) {
    console.error(`[supersurf] could not hand over to supersurf-shim: ${err instanceof Error ? err.message : String(err)}; running the Node server.`);
    return null;
  }
}
