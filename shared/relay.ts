/**
 * Helpers for handing a process's stdio to `supersurf-shim` (the `agents.relay` switch).
 * One copy, used by the server bin, the CLI binary and the daemon. Node built-ins only.
 *
 * @module relay
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { ConfigService, loadJsonConfig, loadEnvConfig } from './config/index';
import type { PartialConfig } from './config/index';

/** `SUPERSURF_SHIM_BIN` (absolute, this process's env) first, then `<root>/bin/supersurf-shim`; the file must be executable. */
export function findShimBinary(root?: string): string | null {
  const env = process.env.SUPERSURF_SHIM_BIN;
  const candidates = [
    ...(env && path.isAbsolute(env) ? [env] : []),
    ...(root ? [path.join(root, 'bin', 'supersurf-shim')] : []),
  ];
  return candidates.find((c) => {
    try { fs.accessSync(c, fs.constants.X_OK); return fs.statSync(c).isFile(); } catch { return false; }
  }) ?? null;
}

/** The shim's argv from an MCP server argv: the resolved port, then only the flags the shim reads. */
export function shimArgs(argv: string[], port: number): string[] {
  const out = ['--port', String(port)];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--debug' || a.startsWith('--debug=')) {
      out.push('--debug');
      if (a === '--debug' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) i++;
    } else if (a === '--disable-secure-eval' || a === '--disable-playbook-eval' || a === '--multi-agent') {
      out.push(a);
    }
  }
  return out;
}

export interface ExecDeps {
  execve?: typeof process.execve;
  spawn?: typeof spawn;
}

/**
 * Replace this process with `file` (`process.execve`, Node >= 22.15: same pid, no parent left).
 * Without it: spawn with inherited stdio, forward SIGINT/SIGTERM/SIGHUP, resolve the child's exit
 * code (`128 + signum` on a signal death). A throw or a spawn error rejects so the caller can fall back.
 */
export function execReplace(file: string, args: string[], deps: ExecDeps = {}): Promise<number> {
  const execve = 'execve' in deps ? deps.execve : process.execve;
  if (execve) {
    try { execve.call(process, file, [file, ...args], process.env); } catch (err) { return Promise.reject(err); }
  }
  return new Promise<number>((resolve, reject) => {
    const child = (deps.spawn ?? spawn)(file, args, { stdio: 'inherit' });
    const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const handlers = sigs.map((s) => {
      const h = () => { try { child.kill(s); } catch { /* already gone */ } };
      process.on(s, h);
      return h;
    });
    const done = () => sigs.forEach((s, i) => process.off(s, handlers[i]));
    child.on('error', (err) => { done(); reject(err); });
    child.on('exit', (code, signal) => {
      done();
      resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0));
    });
  });
}

/**
 * The relay switch and port for a process with no Commander (the CLI binary): `--relay` and
 * `--port N|=N` from `argv`, `SUPERSURF_CONFIG_FILE || ~/.supersurf/config.json`, the env.
 * Silent: no scaffold, no warnings.
 */
export function readRelaySwitch(argv: string[]): { relay: boolean; port: number } {
  const cli: PartialConfig = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--relay') cli.agents = { ...(cli.agents || {}), relay: true };
    else if (a === '--port' && argv[i + 1] !== undefined) cli.daemon = { port: parseInt(argv[++i], 10) };
    else if (a.startsWith('--port=')) cli.daemon = { port: parseInt(a.slice(7), 10) };
  }
  const file = loadJsonConfig(process.env.SUPERSURF_CONFIG_FILE || path.join(os.homedir(), '.supersurf', 'config.json')).config;
  const env = loadEnvConfig(process.env).config;
  const c = new ConfigService({ cli, env, file }).get();
  return { relay: c.agents.relay, port: c.daemon.port };
}
