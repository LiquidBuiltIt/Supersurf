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
 * Run `npx <pkg>@<VERSION> <args...>` and hand it this process's fds.
 *
 * Returns a promise that NEVER SETTLES, and that is the honest type. `spawn` is
 * asynchronous, so control really does come back to the caller here — a bare
 * `never` return would be a lie that TypeScript then propagates, marking every
 * statement after a call site unreachable and letting `runRun` resolve
 * `undefined` while its signature promises a `number`. Nothing after the spawn
 * is ever observed because this process leaves from the `exit` handler below,
 * so a pending promise models the control flow exactly. `Promise<never>` is
 * assignable to any `Promise<T>`, so call sites that return it from a
 * `Promise<number>` still typecheck.
 */
export function shellOut(pkg: NpmTarget, args: string[]): Promise<never> {
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

  // Deliberately never resolved or rejected — see the docblock.
  return new Promise<never>(() => {});
}
