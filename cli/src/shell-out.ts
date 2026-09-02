/**
 * The binary's only reach mechanism into the npm packages.
 *
 * A compiled binary has no node_modules, so `require.resolve` is meaningless
 * inside it and shelling out is the only option for anything that needs the
 * server's or daemon's runtime dependency graph.
 *
 * `stdio: 'inherit'` hands the child the REAL file descriptors — there is no
 * JSON-RPC relay and no per-message copy, which matters because `mcp` is a
 * stdio protocol server. The parent forwards SIGTERM/SIGINT, and `shellOut`
 * hands the child's exit code back to its caller to act on.
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
 * Run `npx <pkg>@<VERSION> <args...>` and hand it this process's fds.
 *
 * Resolves with the child's exit code; it never exits the process itself. That
 * is this tree's convention — the runner returns a code and the CALLER decides
 * what to do with it (`playbook-cli.ts` assigns it to `process.exitCode`, the
 * dispatcher passes it to `process.exit`). A shell-out that left from its own
 * `exit` handler made `runRun`'s `Promise<number>` decorative: the number it
 * promised could never arrive.
 *
 * A signal death becomes `128 + signum`, the shell convention, so a child killed
 * by SIGINT is distinguishable from one that chose to exit 2. A spawn that never
 * produced a child resolves 1 after explaining why.
 */
export function shellOut(pkg: NpmTarget, args: string[]): Promise<number> {
  return new Promise<number>((resolve) => {
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
      // `error` and `exit` can both fire on a failed spawn; the first resolve wins.
      resolve(1);
    });

    child.on('exit', (code, signal) => {
      resolve(signal ? 128 + (require('node:os').constants.signals[signal] ?? 0) : (code ?? 0));
    });
  });
}
