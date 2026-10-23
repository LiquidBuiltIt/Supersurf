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
  readDaemonPid,
  isProcessAlive,
} from 'shared';
import { ExtensionBridge } from './extension-bridge';
import { SessionRegistry } from './session';
import { RequestScheduler } from './scheduler';
import { IPCServer } from './ipc';
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

/** Clean stale PID/socket files if the referenced process is dead. */
function cleanStaleFiles(): void {
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (!isNaN(pid) && !isProcessAlive(pid)) {
        fs.unlinkSync(PID_FILE);
        if (fs.existsSync(SOCK_FILE)) {
          fs.unlinkSync(SOCK_FILE);
        }
      }
    } catch {
      // If we can't read the PID file, clean both
      try { fs.unlinkSync(PID_FILE); } catch {}
      try { fs.unlinkSync(SOCK_FILE); } catch {}
    }
  } else if (fs.existsSync(SOCK_FILE)) {
    // Orphaned socket file without a PID file — clean it
    try { fs.unlinkSync(SOCK_FILE); } catch {}
  }
}

/** Write current PID to the PID file. */
function writePidFile(): void {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

/** Remove PID and socket files on shutdown. */
function cleanupFiles(): void {
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(SOCK_FILE); } catch {}
}

// ─── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { port: cliPort, debug, verbose, command, portExplicit } = parseArgs(process.argv);

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
  const logger = new FileLogger(LOG_FILE);
  logger.enable();
  (global as any).DAEMON_LOGGER = logger;
  if (debug) {
    (global as any).DAEMON_DEBUG = true;
  }

  logger.log(`[Daemon] Starting daemon (port=${port}, pid=${process.pid})`);

  // Ensure ~/.supersurf/ exists
  if (!fs.existsSync(SUPERSURF_DIR)) {
    fs.mkdirSync(SUPERSURF_DIR, { recursive: true });
  }

  // Clean stale files from a crashed previous instance
  cleanStaleFiles();

  // Check if daemon is already running
  const existingPid = readDaemonPid();
  if (existingPid !== null && isProcessAlive(existingPid)) {
    console.error(`Daemon already running (pid ${existingPid})`);
    process.exit(1);
  }

  // Write PID file
  writePidFile();

  // Experiment defaults come from the resolved config snapshot (file + env merged).
  const expSnapshot = cfg.get().experiments;

  const version = getVersion();

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

  // Pull extension from GitHub if not cached. A failure is not fatal at
  // startup — a cached copy may still be usable, and unmanaged (bring-your-own
  // Chromium) sessions never touch this directory. But it IS fatal to a managed
  // profile spawn, so the reason is carried forward to spawnProfile rather than
  // being swallowed into daemon.log, where it only ever resurfaced as a
  // 45s match timeout with no cause attached.
  let extensionPullError: string | null = null;
  try {
    await ensureExtension();
  } catch (err: any) {
    extensionPullError = err?.message ? String(err.message) : String(err);
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
  }

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
  const ipc = new IPCServer(SOCK_FILE, bridge, sessions, scheduler, experiments, profileRegistry, { port, version, startupOpts, extensionPullError });

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
      shutdown();
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

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log('[Daemon] Shutting down...');
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
    await ipc.stop();
    await bridge.stop();
    cleanupFiles();
    logger.log('[Daemon] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Start extension WebSocket server
  try {
    await bridge.start();
    logger.log(`[Daemon] Extension WebSocket listening on port ${port}`);
  } catch (error: any) {
    console.error(`Failed to start extension WebSocket: ${error.message}`);
    cleanupFiles();
    process.exit(1);
  }

  // Start IPC server
  try {
    await ipc.start();
    logger.log(`[Daemon] IPC listening on ${SOCK_FILE}`);
  } catch (error: any) {
    console.error(`Failed to start IPC server: ${error.message}`);
    await bridge.stop();
    cleanupFiles();
    process.exit(1);
  }

  // Start idle timer (no sessions yet)
  startIdleTimer();

  logger.log('[Daemon] Daemon ready');
}

// Export for testing
export { parseArgs, isProcessAlive, cleanStaleFiles, stopDaemon, printStatus, observe, formatUptime, getVersion, SUPERSURF_DIR, PID_FILE, SOCK_FILE, IDLE_TIMEOUT_MS };

/**
 * Self-daemonize: re-spawn this script as a detached background process,
 * then exit the parent so the daemon is not a child of the caller's shell.
 */
function daemonize(argv: string[]): void {
  const args = argv.slice(2).filter(a => a !== 'start' && a !== 'restart');
  args.push('--_daemonized');

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
