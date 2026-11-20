/**
 * Shared rig for the relay tests: the BUILT `server/dist/cli.js` in a throwaway HOME, a recording
 * shim stand-in, and an NDJSON client. Not a test file.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const MCP_BIN = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');

/** Env for a built bin: VITEST removed (daemon main.ts no-ops under it), every relay/dev knob cleared. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('VITEST') || k.startsWith('SUPERSURF_')) delete env[k];
  }
  return { ...env, ...extra };
}

export interface Rig {
  home: string;
  config: string;
  /** A recording shim (answers `--version` with 0 and records nothing): writes `$$` to `pid` and its argv (one per line) to `argv`, then exits `exitCode`. */
  recorder(exitCode?: number): { bin: string; pid: string; argv: string };
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
  cleanup(): void;
}

export function makeRig(): Rig {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssr-'));
  const config = path.join(home, 'config.json');
  return {
    home,
    config,
    recorder(exitCode = 7) {
      const bin = path.join(home, 'rec-shim');
      const pid = path.join(home, 'rec.pid');
      const argv = path.join(home, 'rec.argv');
      fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho $$ > "${pid}"\nprintf '%s\\n' "$@" > "${argv}"\nexit ${exitCode}\n`, { mode: 0o755 });
      return { bin, pid, argv };
    },
    env(extra = {}) {
      return childEnv({ HOME: home, SUPERSURF_CONFIG_FILE: config, ...extra });
    },
    cleanup() { fs.rmSync(home, { recursive: true, force: true }); },
  };
}

export const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'relay-test', version: '0' } },
}) + '\n';

export interface Run {
  child: ChildProcess;
  pid: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The JSON reply to id 1, or null when the process ended without one. */
  initReply: any | null;
}

/**
 * Spawn `node <MCP_BIN> <args>`, send `initialize`, wait for the reply to id 1 or for the process
 * to end, then close stdin and wait for exit (killing after `timeoutMs`).
 */
export function runServer(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const run: Run = { child, pid: child.pid!, code: null, signal: null, stdout: '', stderr: '', initReply: null };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdin!.on('error', () => {});
    child.stdout!.on('data', (d) => {
      run.stdout += d;
      if (!run.initReply) {
        for (const line of run.stdout.split('\n')) {
          try { const j = JSON.parse(line); if (j.id === 1) { run.initReply = j; child.stdin!.end(); } } catch { /* partial line */ }
        }
      }
    });
    child.stderr!.on('data', (d) => { run.stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code, signal) => { run.code = code; run.signal = signal; });
    child.on('close', () => { clearTimeout(timer); resolve(run); });
    child.stdin!.write(INIT);
  });
}
