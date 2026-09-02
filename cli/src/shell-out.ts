/**
 * The binary's only reach mechanism into the npm packages.
 *
 * A compiled binary has no node_modules, so `require.resolve` is meaningless
 * inside it and shelling out is the only option for anything that needs the
 * server's or daemon's runtime dependency graph.
 *
 * `stdio: 'inherit'` hands the child the REAL file descriptors — there is no
 * JSON-RPC relay and no per-message copy, which matters because `mcp` is a
 * stdio protocol server. The parent forwards SIGTERM/SIGINT and exits with the
 * child's exit code.
 *
 * @module shell-out
 */
import { spawn } from 'node:child_process';
import { VERSION } from './version';

export type NpmTarget = 'supersurf-mcp' | 'supersurf-daemon';

/** `supersurf-mcp@3.4.0` — pinned to this binary's version, never `@latest`. */
export function npxTarget(pkg: NpmTarget): string {
  return `${pkg}@${VERSION}`;
}

/**
 * Replace this process with `npx <pkg>@<VERSION> <args...>`. Never returns:
 * it exits with the child's code, or 128+signal when the child was signalled.
 */
export function shellOut(pkg: NpmTarget, args: string[]): never {
  const child = spawn('npx', ['--yes', npxTarget(pkg), ...args], {
    stdio: 'inherit',
  });

  const forward = (sig: NodeJS.Signals) => {
    process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  };
  forward('SIGINT');
  forward('SIGTERM');

  child.on('error', (err) => {
    console.error(
      `[supersurf] Could not run \`npx ${npxTarget(pkg)}\`: ${err.message}\n` +
      `Node.js and npx must be on PATH — the ${pkg} package runs on Node, not inside this binary.`,
    );
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    process.exit(signal ? 128 + (require('node:os').constants.signals[signal] ?? 0) : (code ?? 0));
  });

  return undefined as never;
}
