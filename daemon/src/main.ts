#!/usr/bin/env node
/**
 * SuperSurf Daemon — standalone coordinator for multiple MCP sessions.
 *
 * Manages a single Chrome extension connection (WebSocket) and multiplexes
 * tool calls from multiple MCP servers (Unix domain socket).
 *
 * Usage:
 *   supersurf-daemon [start] [--port <n>] [--debug]
 *   supersurf-daemon stop
 *   supersurf-daemon restart [--port <n>] [--debug]
 *   supersurf-daemon status
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
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import {
  FileLogger,
  ConfigService,
  HARDCODED_DEFAULTS,
  ensureConfigFile,
  loadJsonConfig,
  loadEnvConfig,
} from 'shared';
import { ExtensionBridge } from './extension-bridge';
import { SessionRegistry } from './session';
import { RequestScheduler } from './scheduler';
import { IPCServer } from './ipc';
import { DaemonExperimentRegistry } from './experiments/index';
import { ProfileRegistry } from './profiles/registry';
import { ensureExtension } from './profiles/extension-source';
import { replayPidLog, findOrphanPids, killOrphanPids, truncatePidLog, appendPidLog } from './profiles/chrome';

const SUPERSURF_DIR = path.join(os.homedir(), '.supersurf');
const PID_FILE = path.join(SUPERSURF_DIR, 'daemon.pid');
const SOCK_FILE = path.join(SUPERSURF_DIR, 'daemon.sock');
const LOG_FILE = path.join(SUPERSURF_DIR, 'logs', 'daemon.log');
// Retained as a backwards-compatible export; runtime now reads the live value
// from ConfigService (cfg.get().daemon.idle_timeout_ms).
const IDLE_TIMEOUT_MS = HARDCODED_DEFAULTS.daemon.idle_timeout_ms;

// ─── CLI Parsing ──────────────────────────────────────────────

function parseArgs(argv: string[]): { port: number; debug: boolean; verbose: boolean; command?: string; portExplicit: boolean } {
  let port = HARDCODED_DEFAULTS.daemon.port;
  let portExplicit = false;
  let debug = false;
  let verbose = false;
  let command: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      port = parseInt(argv[i + 1], 10);
      if (isNaN(port)) {
        console.error('Invalid port number');
        process.exit(1);
      }
      portExplicit = true;
      i++;
    } else if (argv[i] === '--debug') {
      debug = true;
    } else if (argv[i] === '--verbose') {
      verbose = true;
    } else if (argv[i] === 'start') {
      command = 'start';
    } else if (argv[i] === 'stop') {
      command = 'stop';
    } else if (argv[i] === 'restart') {
      command = 'restart';
    } else if (argv[i] === 'status') {
      command = 'status';
    } else if (argv[i] === 'observe') {
      command = 'observe';
    }
  }

  return { port, debug, verbose, command, portExplicit };
}

// ─── Status Command ──────────────────────────────────────────

/** Query the daemon over the Unix socket for live state. */
function queryDaemonStatus(verbose: boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCK_FILE)) {
      reject(new Error('Socket not found'));
      return;
    }

    const socket = net.createConnection(SOCK_FILE);
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Query timeout'));
    }, 3000);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ type: 'daemon_status', verbose }) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(buffer.slice(0, idx)));
        } catch {
          reject(new Error('Invalid response'));
        }
        socket.end();
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Format uptime seconds into human-readable string. */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/** Read package version from package.json */
function getVersion(): string {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pkg.name === 'supersurf' || pkg.name === 'supersurf-daemon') {
        return pkg.version || 'unknown';
      }
    } catch { /* try next */ }
  }
  return 'unknown';
}

async function printStatus(verbose: boolean): Promise<void> {
  const daemonRunning = fs.existsSync(PID_FILE);
  let pid: number | null = null;
  let alive = false;

  if (daemonRunning) {
    try {
      pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      alive = !isNaN(pid) && isProcessAlive(pid);
    } catch {}
  }

  if (!alive) {
    console.log('Daemon not running');
    if (daemonRunning) console.log('(stale PID file found — will be cleaned on next start)');
    process.exit(1);
    return;
  }

  // Try live query
  try {
    const status = await queryDaemonStatus(verbose);

    if (verbose) {
      const version = status.version || getVersion();
      console.log(`SuperSurf Daemon v${version}`);
      console.log(`  PID:        ${pid}`);
      console.log(`  Uptime:     ${formatUptime(status.uptimeSeconds)}`);
      console.log(`  Port:       ${status.port}`);
      console.log(`  Socket:     ${SOCK_FILE}`);
      console.log(`  Log:        ${LOG_FILE}`);
      console.log('');
      console.log('Extension');
      console.log(`  Status:     ${status.extensionConnected ? 'connected' : 'disconnected'}`);
      if (status.extensionBrowser) {
        console.log(`  Browser:    ${status.extensionBrowser}`);
      }
      console.log('');
      console.log(`Sessions (${status.sessions.length})`);
      if (status.sessions.length === 0) {
        console.log('  (none)');
      } else {
        for (const s of status.sessions) {
          const tab = s.attachedTabId ? `tab #${s.attachedTabId}` : 'no tab';
          const owned = `${s.ownedTabCount} owned tab${s.ownedTabCount !== 1 ? 's' : ''}`;
          console.log(`  ${s.sessionId}   ${tab}   ${owned}`);
        }
      }
      console.log('');
      console.log('Scheduler');
      console.log(`  Queue:      ${status.schedulerQueueDepth} pending`);
    } else {
      const version = status.version || getVersion();
      const ext = status.extensionConnected ? 'connected' : 'disconnected';
      console.log(`SuperSurf Daemon v${version} (pid ${pid})`);
      console.log(`  Uptime:      ${formatUptime(status.uptimeSeconds)}`);
      console.log(`  Extension:   ${ext}`);
      console.log(`  Sessions:    ${status.sessions.length} active`);
      console.log('');
      console.log('Run `supersurf-daemon status --verbose` for full details.');
    }
  } catch {
    // Fallback: socket query failed, show basic PID info
    console.log(`Daemon running (pid ${pid})`);
    console.log(`Socket: ${fs.existsSync(SOCK_FILE) ? SOCK_FILE : 'missing'}`);
  }

  process.exit(0);
}

// ─── Observe Command ─────────────────────────────────────────

function observe(): void {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(`Log file not found: ${LOG_FILE}`);
    process.exit(1);
  }

  console.log(`Tailing ${LOG_FILE} (Ctrl+C to stop)\n`);
  const tail = spawn('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
  tail.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => { tail.kill(); process.exit(0); });
}

// ─── Stop Command ───────────────────────────────────────────

/** Stop the running daemon by sending SIGTERM to the PID in the PID file. */
function stopDaemon(): boolean {
  if (!fs.existsSync(PID_FILE)) {
    console.log('Daemon not running (no PID file)');
    return false;
  }

  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isNaN(pid)) {
      console.log('Daemon not running (invalid PID file)');
      return false;
    }
  } catch {
    console.log('Daemon not running (cannot read PID file)');
    return false;
  }

  if (!isProcessAlive(pid)) {
    console.log(`Daemon not running (stale PID ${pid})`);
    // Clean up stale files
    try { fs.unlinkSync(PID_FILE); } catch {}
    try { fs.unlinkSync(SOCK_FILE); } catch {}
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: any) {
    console.error(`Failed to stop daemon (pid ${pid}): ${err.message}`);
    return false;
  }

  // Wait up to 5s for the process to exit
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (!isProcessAlive(pid)) {
      console.log(`Daemon stopped (pid ${pid})`);
      return true;
    }
    // Busy-wait in small increments (sync — this is a CLI command, not the server)
    const waitUntil = Date.now() + 100;
    while (Date.now() < waitUntil) { /* spin */ }
  }

  // Still alive after 5s — escalate to SIGKILL
  try {
    process.kill(pid, 'SIGKILL');
    console.log(`Daemon killed (pid ${pid}) — did not exit gracefully`);
  } catch {}

  // Clean up files the hard way
  try { fs.unlinkSync(PID_FILE); } catch {}
  try { fs.unlinkSync(SOCK_FILE); } catch {}
  return true;
}

// ─── PID File Management ──────────────────────────────────────

/** Check if a process with the given PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
      console.error(`Daemon already running (pid ${existingPid})`);
      process.exit(1);
    }
  }

  // Write PID file
  writePidFile();

  // Experiment defaults come from the resolved config snapshot (file + env merged).
  const expSnapshot = cfg.get().experiments;

  // Initialize components
  const bridge = new ExtensionBridge(port, '127.0.0.1');
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

  // Pull extension from GitHub if not cached
  try {
    await ensureExtension();
  } catch (err: any) {
    logger.log(`[Daemon] Warning: Failed to pull extension: ${err.message}`);
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

  const version = getVersion();
  const startupOpts = {
    disableGpu: cfg.get().profiles.startup_opts.disable_gpu,
    chromePath: cfg.get().profiles.chrome_path,
  };
  const ipc = new IPCServer(SOCK_FILE, bridge, sessions, scheduler, experiments, profileRegistry, { port, version, startupOpts });

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
