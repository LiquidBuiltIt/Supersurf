#!/usr/bin/env node
/**
 * SuperSurf Daemon — standalone coordinator for multiple MCP sessions.
 *
 * Manages a single Chrome extension connection (WebSocket) and multiplexes
 * tool calls from multiple MCP servers (Unix domain socket).
 *
 * Usage (the daemon is not on PATH — see `daemonCommand` in shared/commands):
 *   npx supersurf-daemon@latest [start] [--port <n>] [--debug]
 *   npx supersurf-daemon@latest stop
 *   npx supersurf-daemon@latest restart [--port <n>] [--debug]
 *   npx supersurf-daemon@latest status
 *
 * Files:
 *   ~/.supersurf/daemon.pid   — PID file for process detection
 *   ~/.supersurf/daemon.sock  — Unix domain socket for MCP server IPC
 *   ~/.supersurf/logs/daemon.log — debug log (when --debug)
 *
 * @module main
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import {
  FileLogger,
  ConfigService,
  HARDCODED_DEFAULTS,
  ensureConfigFile,
  loadJsonConfig,
  loadEnvConfig,
  checkAndTouchVersionState,
  UPGRADE_NOTICE_MESSAGE,
  isProcessAlive,
} from 'shared';
import { ExtensionBridge } from './extension-bridge';
import { SessionRegistry } from './session';
import { RequestScheduler } from './scheduler';
import { IPCServer, type IPCServerMeta } from './ipc';
import { ShimServer } from './shim-server';
import { acquirePidFile, releaseFiles, clearStaleSocket, sockIdentity, type SockIdentity } from './pidfile';
import { DaemonExperimentRegistry } from './experiments/index';
import { ProfileRegistry } from './profiles/registry';
import { ensureExtension, isExtensionCached, getExtensionDir } from './profiles/extension-source';
import { replayPidLog, findOrphanPids, killOrphanPids, truncatePidLog, appendPidLog } from './profiles/chrome';
import {
  SUPERSURF_DIR,
  PID_FILE,
  SOCK_FILE,
  LOG_FILE,
  parseArgs,
  formatUptime,
  getVersion,
  printStatus,
  observe,
  stopDaemon,
} from './cli-commands';

// Retained as a backwards-compatible export; runtime now reads the live value
// from ConfigService (cfg.get().daemon.idle_timeout_ms).
const IDLE_TIMEOUT_MS = HARDCODED_DEFAULTS.daemon.idle_timeout_ms;

// ─── PID File Management ──────────────────────────────────────

/** Identity (inode + ctime) of the socket this process bound; `cleanupFiles` removes only that one. */
let boundSock: SockIdentity | null = null;

/** Remove this daemon's own pidfile and socket — never another daemon's (see pidfile.ts). */
function cleanupFiles(): void {
  releaseFiles(PID_FILE, SOCK_FILE, boundSock);
}

// ─── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { port: cliPort, debug, verbose, command, portExplicit, startReason } = parseArgs(process.argv);

  if (command === 'status') {
    await printStatus(verbose);
    return;
  }

  if (command === 'stop') {
    stopDaemon();
    return;
  }

  if (command === 'restart') {
    stopDaemon();
    // Fall through to start the daemon fresh
  }

  if (command === 'observe') {
    observe();
    return;
  }

  // The directory holds the socket, pidfile and config: owner-only, and before
  // anything below creates files in it (or listens).
  fs.mkdirSync(SUPERSURF_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(SUPERSURF_DIR, 0o700);

  // Initialize ConfigService — scaffold ~/.supersurf/config.json on first run,
  // then merge CLI (port) + env + file inputs into a single resolved snapshot.
  const configPath = process.env.SUPERSURF_CONFIG_FILE
    || path.join(os.homedir(), '.supersurf', 'config.json');
  const scaffold = ensureConfigFile(configPath);
  if (scaffold.created) {
    console.log(`[daemon] Scaffolded default config at ${configPath}`);
  }
  const { config: fileCfg, warnings: fileWarn } = loadJsonConfig(configPath);
  const { config: envCfg, warnings: envWarn } = loadEnvConfig(process.env);
  for (const w of [...fileWarn, ...envWarn]) console.warn(`[daemon] ${w}`);
  const cfg = new ConfigService({
    cli: portExplicit ? { daemon: { port: cliPort } } : {},
    env: envCfg,
    file: fileCfg,
    onWarn: (m) => console.warn(`[daemon] ${m}`),
  });
  const port = cfg.get().daemon.port;
  const idleTimeoutMs = cfg.get().daemon.idle_timeout_ms;

  // Initialize logger — always enabled for core events
  const logger = new FileLogger(LOG_FILE, { maxBytes: 5 * 1024 * 1024 });
  logger.enable();
  (global as any).DAEMON_LOGGER = logger;
  if (debug) {
    (global as any).DAEMON_DEBUG = true;
  }

  const version = getVersion();
  logger.log(`[Daemon] Starting daemon (port=${port}, pid=${process.pid}, version=${version}, start_reason=${startReason})`);

  // Single-instance lock: create-exclusive pidfile. The loser exits here, before
  // it has any file of its own to clean up.
  const lock = acquirePidFile(PID_FILE);
  if (!lock.acquired) {
    console.error(`Daemon already running (pid ${lock.pid})`);
    process.exit(1);
  }

  // A crash must not leave this daemon's files behind, and must not touch anyone else's.
  const onCrash = (kind: string) => (err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.log(`[Daemon] ${kind}: ${detail}`);
    console.error(`Daemon ${kind}:`, err);
    cleanupFiles();
    process.exit(1);
  };
  process.on('uncaughtException', onCrash('uncaughtException'));
  process.on('unhandledRejection', onCrash('unhandledRejection'));

  // Experiment defaults come from the resolved config snapshot (file + env merged).
  const expSnapshot = cfg.get().experiments;

  // Initialize components
  const bridge = new ExtensionBridge(port, '127.0.0.1', version);
  const sessions = new SessionRegistry();
  const scheduler = new RequestScheduler(bridge, sessions);
  const experiments = new DaemonExperimentRegistry({ defaults: expSnapshot });

  const enabledDefaults = Object.entries(expSnapshot)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (enabledDefaults.length > 0) {
    logger.log(`[Daemon] Experiment defaults: ${enabledDefaults.join(', ')}`);
  }

  // Ensure ~/.supersurf/daemon/ exists
  fs.mkdirSync(path.join(SUPERSURF_DIR, 'daemon'), { recursive: true });

  // Initialize profile registry
  const profileRegistry = new ProfileRegistry(path.join(SUPERSURF_DIR, 'profiles'));

  // Kill orphan Chromium processes from previous crash
  const entries = replayPidLog();
  const orphans = findOrphanPids(entries);
  if (orphans.length > 0) {
    logger.log(`[Daemon] Cleaning up ${orphans.length} orphan Chromium process(es)`);
    killOrphanPids(orphans);
  }
  truncatePidLog();

  const startupOpts = {
    disableGpu: cfg.get().profiles.startup_opts.disable_gpu,
    chromePath: cfg.get().profiles.chrome_path,
  };
  const ipcMeta: IPCServerMeta = { port, version, startupOpts, extensionPullError: null };
  const ipc = new IPCServer(SOCK_FILE, bridge, sessions, scheduler, experiments, profileRegistry, ipcMeta);
  // The engine worker starts at the first `shim_register`; until then this costs nothing.
  const shim = new ShimServer({ host: ipc, experiments, daemon: { configPath, port, version } });
  ipc.setShimServer(shim);

  // Watch ~/.supersurf/config.json for post-startup edits. The daemon snapshots
  // config at startup and never hot-reloads — drift means the user's edits won't
  // take effect until restart. We surface this through the IPC envelope so the
  // server can warn the agent on the next response.
  const hashFile = (p: string): string => {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    } catch {
      return '';
    }
  };
  const initialHash = hashFile(configPath);
  try {
    fs.watch(configPath, { persistent: false }, () => {
      const current = hashFile(configPath);
      if (current && current !== initialHash) {
        ipc.setConfigDrift(true);
        logger.log('[Daemon] config.json changed since startup — restart required to apply');
      }
    });
  } catch (err: any) {
    logger.log(`[Daemon] Warning: failed to watch ${configPath}: ${err.message}`);
  }

  // Idle timeout: exit after the configured idle window with no sessions
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function startIdleTimer(): void {
    resetIdleTimer();
    idleTimer = setTimeout(() => {
      logger.log(`[Daemon] Idle timeout — no sessions for ${idleTimeoutMs}ms, exiting`);
      shutdown('idle_timeout');
    }, idleTimeoutMs);
  }

  ipc.setSessionCountCallback((count: number) => {
    logger.log(`[Daemon] Session count: ${count}`);
    if (count === 0) {
      if (profileRegistry.hasUserOwnedRunning()) {
        // A human-opened browser is alive — idling out would strand it
        // (next daemon start could not adopt/kill it and connect latency
        // would suffer). Stay up; the Chromium exit handler re-invokes
        // this callback when the browser closes.
        logger.log('[Daemon] Idle timer suppressed — user-owned browser running');
      } else {
        startIdleTimer();
      }
    } else {
      resetIdleTimer();
    }
  });

  // Graceful shutdown
  let shuttingDown = false;

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log(`[Daemon] Shutting down (reason=${reason})...`);
    resetIdleTimer();

    // Kill all managed Chromium processes — except user-owned ones
    // (launched via `supersurf profiles open`): the human closes those.
    const profiles = profileRegistry.list();
    for (const p of profiles) {
      const pid = profileRegistry.getRunningPid(p.name);
      if (pid !== null) {
        if (profileRegistry.isUserOwned(p.name)) {
          logger.log(`[Daemon] Leaving user-owned Chromium for profile "${p.name}" (pid ${pid}) running`);
          continue;
        }
        try {
          process.kill(pid, 'SIGTERM');
          logger.log(`[Daemon] Killed Chromium for profile "${p.name}" (pid ${pid})`);
          appendPidLog({ action: 'kill', profile: p.name, pid, ts: new Date().toISOString() });
        } catch {}
        profileRegistry.clearRunningPid(p.name);
      }
    }

    scheduler.drainAll();
    shim.stop();
    await ipc.stop();
    await bridge.stop();
    cleanupFiles();
    logger.log('[Daemon] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start extension WebSocket server. A port held by someone else is a startup
  // failure and exits before the socket exists, so the spawner reports EADDRINUSE.
  try {
    await bridge.start();
    logger.log(`[Daemon] Extension WebSocket listening on port ${port}`);
  } catch (error: any) {
    console.error(`Failed to start extension WebSocket: ${error.message}`);
    cleanupFiles();
    process.exit(1);
  }

  // Start IPC server. Holding the pidfile makes an existing socket file a leftover
  // unless something still listens on it; then this daemon backs off untouched.
  try {
    if (!(await clearStaleSocket(SOCK_FILE))) {
      console.error(`Another daemon is already listening on ${SOCK_FILE}`);
      await bridge.stop();
      cleanupFiles();
      process.exit(1);
    }
    await ipc.start();
    boundSock = sockIdentity(SOCK_FILE);
    logger.log(`[Daemon] IPC listening on ${SOCK_FILE}`);
  } catch (error: any) {
    console.error(`Failed to start IPC server: ${error.message}`);
    await bridge.stop();
    cleanupFiles();
    process.exit(1);
  }

  // Pull extension from GitHub if not cached — started only after the socket is
  // listening, so the network time is not startup time; managed spawns wait on
  // `extensionReady`, unmanaged sessions never need it. A failure is not fatal at
  // startup — a cached copy may still be usable, and unmanaged (bring-your-own
  // Chromium) sessions never touch this directory. But it IS fatal to a managed
  // profile spawn, so the reason is carried forward to spawnProfile rather than
  // being swallowed into daemon.log, where it only ever resurfaced as a
  // 45s match timeout with no cause attached.
  ipcMeta.extensionReady = ensureExtension().catch((err: any) => {
    const extensionPullError = err?.message ? String(err.message) : String(err);
    ipcMeta.extensionPullError = extensionPullError;
    logger.log(`[Daemon] Failed to pull extension: ${extensionPullError}`);
    const cached = isExtensionCached();
    // Note on reach: `daemon start` re-spawns itself via daemonize() with
    // stdio 'ignore', so this line is only visible on the foreground path.
    // Under the server it lands in daemon.startup.log, which is read only when
    // the daemon dies — and a pull failure is not fatal. The throw in
    // spawnProfile is therefore what actually reaches a human; this is the
    // cheap second surface, not the primary one.
    console.error(
      `SuperSurf: could not download the browser extension — ${extensionPullError}\n` +
      (cached
        ? `  Using the cached copy at ${getExtensionDir()}. It may be out of date.`
        : `  No cached copy at ${getExtensionDir()}. Managed profiles cannot start until this succeeds.`),
    );
  });

  // Start idle timer (no sessions yet)
  startIdleTimer();

  logger.log('[Daemon] Daemon ready');
}

// Export for testing
export { parseArgs, isProcessAlive, stopDaemon, printStatus, observe, formatUptime, getVersion, SUPERSURF_DIR, PID_FILE, SOCK_FILE, IDLE_TIMEOUT_MS };

/**
 * Self-daemonize: re-spawn this script as a detached background process,
 * then exit the parent so the daemon is not a child of the caller's shell.
 */
function daemonize(argv: string[]): void {
  const args = argv.slice(2).filter(a => a !== 'start' && a !== 'restart');
  args.push('--_daemonized');
  if (!args.some(a => a.startsWith('--start-reason='))) {
    args.push(`--start-reason=${argv.includes('restart') ? 'restart' : 'start'}`);
  }

  const child = spawn(process.execPath, [__filename, ...args], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
  console.log(`Daemon started (pid ${child.pid})`);
  process.exit(0);
}

// Only run when executed directly (not imported by tests)
const isDirectRun = !process.env.VITEST;
if (isDirectRun) {
  const { command } = parseArgs(process.argv);
  const isDaemonized = process.argv.includes('--_daemonized');

  // Human-facing subcommands only (start/stop/restart/status/observe) — never the
  // detached background daemon child (--_daemonized) or a silent programmatic spawn
  // (e.g. ensureDaemon from the server), both of which have their stdio ignored anyway.
  if (command !== undefined && !isDaemonized) {
    const versionCheck = checkAndTouchVersionState(getVersion());
    if (versionCheck.shouldNotify) {
      console.log(UPGRADE_NOTICE_MESSAGE);
    }
  }

  if (command === 'start' || command === 'restart') {
    // Explicit CLI command — self-daemonize (fork + exit parent)
    if (isDaemonized) {
      // We ARE the detached child — run the daemon
      main().catch(() => { cleanupFiles(); process.exit(1); });
    } else {
      if (command === 'restart') stopDaemon();
      daemonize(process.argv);
    }
  } else {
    // No start/restart command: either a query (status/stop/observe) or
    // programmatic spawn (e.g. ensureDaemon) — run main() directly
    main().catch((error) => {
      console.error('Daemon fatal error:', error);
      cleanupFiles();
      process.exit(1);
    });
  }
}
