/**
 * The `agents.relay` decision for `supersurf mcp`: hand this process's stdio to `supersurf-shim`
 * (execve where the runtime has it, Bun included), or return `null` and let the usual shell-out run.
 *
 * Off, `--script-mode` and "no shim found" all return `null` silently; the server (which reads the
 * same switch) warns once about a missing binary.
 *
 * @module relay
 */
import { devSource, execReplace, findShimBinary, probeShim, readRelaySwitch, shimArgs } from 'shared';

/** @param args the `mcp` argv after the subcommand. @returns the shim's exit code, or `null` to shell out. */
export async function relayMcp(args: string[]): Promise<number | null> {
  if (args.includes('--script-mode')) return null;
  const { relay, port } = readRelaySwitch(args);
  if (!relay) return null;
  // A compiled binary has no package root, so no `<root>/bin` candidate.
  const bin = findShimBinary() ?? devSource('shim');
  if (!bin) return null;
  try {
    probeShim(bin); // a failed process.execve aborts the process, so prove the binary runs first
    return await execReplace(bin, shimArgs(args, port));
  } catch (err) {
    console.error(`[supersurf] could not hand over to supersurf-shim: ${err instanceof Error ? err.message : String(err)}; running the Node server.`);
    return null;
  }
}
