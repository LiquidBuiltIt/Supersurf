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
import { Handoff, nextSockPath, appendSpawn, waitForCommit, waitOldExit, bindWithBackoff, shimModelInUse, upgradePending, entryExists, type UserOwned } from './handoff';
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
  restartDaemon,
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

/** What a crash must clean up; `main` replaces it once it knows its role in a hand-off. */
let crashCleanup: () => void = cleanupFiles;

/**
 * TEST-ONLY crash points for the real-process hand-off tests (`handoff-gap.test.ts`).
 * Read here and nowhere else; inert unless `SUPERSURF_TEST_HANDOFF_FAULT` and `SUPERSURF_DEV_ENVIRONMENT` are both set.
 */
function testHandoffFault(): ((point: 'after-spawn' | 'after-pid-rename') => void) | undefined {
  // Also needs SUPERSURF_DEV_ENVIRONMENT: a server-spawned daemon inherits the MCP client's env.
  if (!process.env.SUPERSURF_DEV_ENVIRONMENT) return undefined;
  const v = process.env.SUPERSURF_TEST_HANDOFF_FAULT;
  if (v === 'crash-after-spawn') return (p) => { if (p === 'after-spawn') setTimeout(() => { throw new Error('test crash after spawn'); }, 500); };
  if (v === 'throw-after-pid-rename') return (p) => { if (p === 'after-pid-rename') throw new Error('test throw after the pid rename'); };
  if (v === 'kill-after-pid-rename') return (p) => { if (p === 'after-pid-rename') process.kill(process.pid, 'SIGKILL'); };
  return undefined;
}

// ─── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { port: cliPort, debug, verbose, command, portExplicit, startReason, takeover } = parseArgs(process.argv);

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
  logger.log(`[Daemon] Starting daemon (port=${port}, pid=${process.pid}, version=${version}, start_reason=${startReason}${takeover ? `, takeover=${takeover}` : ''})`);

  // Single-instance lock: create-exclusive pidfile. The loser exits here, before
  // it has any file of its own to clean up. A hand-off successor skips it: the old
  // daemon is alive and writes the pidfile for it at the commit.
  if (!takeover) {
    const lock = acquirePidFile(PID_FILE);
    if (!lock.acquired) {
      console.error(`Daemon already running (pid ${lock.pid})`);
      process.exit(1);
    }
  }

  // Restart hand-off state. Old daemon: `handoff`. Successor: `takeoverPhase`, `ownNextIno`.
  let handoff: Handoff | null = null;
  let takeoverPhase: 'ready' | 'committed' | null = takeover ? 'ready' : null;
  /** A successor is whole once the old daemon is gone and the extension pull is done. */
  let successorWhole = !takeover;
  let bindError: string | null = null;
  let ownNextIno: number | null = null;
  let commitSignal: (msg: any) => void = () => {};

  // A crash must not leave this daemon's files behind, and must not touch anyone else's.
  crashCleanup = () => {
    if (handoff?.past) return; // the successor owns the files now
    handoff?.abortSync();
    if (takeover && takeoverPhase === 'ready') {
      try { if (fs.statSync(nextSockPath()).ino === ownNextIno) fs.unlinkSync(nextSockPath()); } catch {}
      return;
    }
    cleanupFiles();
  };
  const onCrash = (kind: string) => (err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.log(`[Daemon] ${kind}: ${detail}`);
    console.error(`Daemon ${kind}:`, err);
    crashCleanup();
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

  // Kill orphan Chromium processes from previous crash. A hand-off successor does
  // this only at the commit, and only on the poll path (item 6): the old daemon owns
  // those browsers until then.
  const coldStartSweep = (): UserOwned[] => {
    const entries = replayPidLog();
    const orphans = findOrphanPids(entries);
    if (orphans.length > 0) {
      logger.log(`[Daemon] Cleaning up ${orphans.length} orphan Chromium process(es)`);
      killOrphanPids(orphans);
    }
    truncatePidLog();
    return entries
      .filter((e) => e.action === 'spawn' && e.owner === 'user' && isProcessAlive(e.pid) && !entries.some((k) => k.action === 'kill' && k.pid === e.pid))
      .map((e) => ({ profile: e.profile, pid: e.pid }));
  };
  if (!takeover) coldStartSweep();

  const startupOpts = {
    disableGpu: cfg.get().profiles.startup_opts.disable_gpu,
    chromePath: cfg.get().profiles.chrome_path,
  };
  const ipcMeta: IPCServerMeta = { port, version, startupOpts, extensionPullError: null };
  let openSpawnGate: () => void = () => {};
  if (takeover) ipcMeta.spawnGate = new Promise<void>((r) => { openSpawnGate = r; });
  const ipc = new IPCServer(takeover ? nextSockPath() : SOCK_FILE, bridge, sessions, scheduler, experiments, profileRegistry, ipcMeta);
  // The engine worker starts at the first `shim_register`; until then this costs nothing.
  const shim = new ShimServer({ host: ipc, experiments, daemon: { configPath, port, version }, log: (m) => logger.log(m) });
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
      if (handoff?.busy) return; // never while a hand-off runs (R4)
      logger.log(`[Daemon] Idle timeout — no sessions for ${idleTimeoutMs}ms, exiting`);
      shutdown('idle_timeout');
    }, idleTimeoutMs);
  }

  ipc.setSessionCountCallback((count: number) => {
    logger.log(`[Daemon] Session count: ${count}`);
    if (handoff?.busy) return; // the end of the hand-off re-arms the timer
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
      checkUpgradeExit();
    } else {
      resetIdleTimer();
    }
  });

  // Graceful shutdown
  let shuttingDown = false;

  /** SIGTERM every managed Chromium except user-owned ones (launched via `supersurf profiles open`: the human closes those). Returns the pids signalled. */
  function killOwnedChromium(): number[] {
    const killed: number[] = [];
    for (const p of profileRegistry.list()) {
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
          killed.push(pid);
        } catch {}
        profileRegistry.clearRunningPid(p.name);
      }
    }
    return killed;
  }

  /** The shim model is in use: the D3 exit and the `restart` hand-off apply only then. */
  const shimModel = (): boolean => shimModelInUse({ servedShim: shim.served, startReason, entryExists: entryExists() });
  const pendingUpgrade = (): { from: string; to: string } | null => (shimModel() ? upgradePending(version) : null);

  /** D3: `entry` names a newer daemon. Exit only with no session of either model, no hand-off and no user-owned browser. */
  function checkUpgradeExit(): void {
    if (!successorWhole || shuttingDown || handoff?.busy || sessions.count > 0 || profileRegistry.hasUserOwnedRunning()) return;
    const p = pendingUpgrade();
    if (!p) return;
    logger.log(`[Daemon] Upgrade pending (${p.from} -> ${p.to}) and no sessions, exiting`);
    void shutdown('upgrade_pending');
  }
  setInterval(checkUpgradeExit, 5000).unref();

  async function shutdown(reason: string): Promise<void> {
    if (handoff?.past) { logger.log(`[Daemon] Ignoring shutdown (reason=${reason}): the hand-off is committed`); return; }
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log(`[Daemon] Shutting down (reason=${reason})...`);
    resetIdleTimer();

    // First: the engine worker closes its links while the extension is still up.
    try {
      await shim.stop();
    } catch (err: any) {
      logger.log(`[Daemon] Shim server stop failed: ${err?.message ?? err}`);
    }

    killOwnedChromium();

    scheduler.drainAll();
    await ipc.stop();
    await bridge.stop();
    cleanupFiles();
    logger.log('[Daemon] Shutdown complete');
    process.exit(0);
  }

  // Restart hand-off, old side. `daemon_restart` starts it; the idle timer, the session callback
  // and shutdown all look at it (R4).
  let handoffRun: Promise<unknown> = Promise.resolve();
  handoff = new Handoff({
    version, port, debug,
    log: (m) => logger.log(m),
    killOwnedChromium,
    userOwned: () => profileRegistry.list()
      .filter((p) => profileRegistry.getRunningPid(p.name) !== null && profileRegistry.isUserOwned(p.name))
      .map((p) => ({ profile: p.name, pid: profileRegistry.getRunningPid(p.name)! })),
    setRestarting: () => { ipc.setRestarting(); shim.notifyRestarting(); },
    stopShims: () => shim.stop(),
    endSessions: () => ipc.endSessions(),
    fault: testHandoffFault(),
  });
  const handoffNow = handoff;
  ipc.setHandoffHook({
    restart: (reply) => {
      // A successor that is not whole yet, a daemon already handing off or shutting down: refuse.
      if (!successorWhole || handoffNow.busy || shuttingDown) return reply({ type: 'handoff_in_progress' });
      resetIdleTimer();
      handoffRun = handoffNow.run(reply).then((r) => {
        if (r === 'failed' && !shuttingDown && sessions.count === 0 && !profileRegistry.hasUserOwnedRunning()) startIdleTimer();
      }).catch((err) => { logger.log(`[Daemon] Hand-off error: ${err?.message ?? err}`); });
    },
    status: () => ({
      ...(takeoverPhase ? { takeover: takeoverPhase } : {}),
      ...(bindError ? { bindError } : {}),
      shimSessions: shim.liveCount,
      shimModel: shimModel(),
      ...(pendingUpgrade() ? { upgradePending: pendingUpgrade() } : {}),
    }),
    takeoverCommit: takeover ? (msg) => commitSignal(msg) : undefined,
  });

  // Before the commit a signal aborts the hand-off and rolls back, then shuts down; after it, it is ignored.
  const onSignal = (sig: string) => {
    if (handoffNow.past) { logger.log(`[Daemon] Ignoring ${sig}: the hand-off is committed`); return; }
    if (handoffNow.busy) {
      handoffNow.aborted = true;
      void handoffRun.then(() => shutdown(sig));
      return;
    }
    void shutdown(sig);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  // Pull extension from GitHub if not cached — started only after the socket is
  // listening, so the network time is not startup time; managed spawns wait on
  // `extensionReady`, unmanaged sessions never need it. A failure is not fatal at
  // startup — a cached copy may still be usable, and unmanaged (bring-your-own
  // Chromium) sessions never touch this directory. But it IS fatal to a managed
  // profile spawn, so the reason is carried forward to spawnProfile rather than
  // being swallowed into daemon.log, where it only ever resurfaced as a
  // 45s match timeout with no cause attached.
  const startExtensionPull = (): Promise<unknown> => {
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
    return ipcMeta.extensionReady;
  };

  if (takeover) {
    // Hand-off successor: listen on `.next` only, say `takeover:"ready"` and wait for the old daemon's commit.
    const NEXT = nextSockPath();
    try {
      await ipc.start();
      boundSock = sockIdentity(NEXT);
      ownNextIno = fs.statSync(NEXT).ino;
      logger.log(`[Daemon] IPC listening on ${NEXT}; waiting for the commit from pid ${takeover}`);
    } catch (error: any) {
      console.error(`Failed to start IPC server on ${NEXT}: ${error.message}`);
      process.exit(1); // owns no shared file yet
    }

    const commitMsg = new Promise<any>((resolve) => { commitSignal = resolve; });
    const res = await waitForCommit({ oldpid: takeover, ownIno: ownNextIno, commitMsg, log: (m) => logger.log(`[Daemon] ${m}`) });
    if (res.kind === 'leave') {
      logger.log(`[Daemon] Hand-off did not commit (${res.reason}); exiting without touching daemon.pid or daemon.sock`);
      process.exit(0);
    }

    takeoverPhase = 'committed';
    boundSock = sockIdentity(SOCK_FILE); // the rename changed the ctime; releaseFiles matches inode and ctime
    let adopted = res.userOwned;
    if (res.viaPoll) {
      adopted = coldStartSweep();
      appendSpawn({ pid: process.pid, entryVersion: version, outcome: 'handoff_committed' });
    }
    for (const u of adopted) {
      profileRegistry.setRunningPid(u.profile, u.pid, 'user');
      logger.log(`[Daemon] Adopted user-owned Chromium for profile "${u.profile}" (pid ${u.pid})`);
    }

    await waitOldExit(takeover, (m) => logger.log(`[Daemon] ${m}`));
    // 5555 was the old daemon's until now. Retry for as long as this daemon runs; never exit on it (R3).
    void bindWithBackoff(() => bridge.start(), port, (e) => { bindError = e; }, (m) => logger.log(`[Daemon] ${m}`));
    await startExtensionPull();
    openSpawnGate();
    successorWhole = true;
    startIdleTimer();
    logger.log('[Daemon] Hand-off complete, daemon ready');
    return;
  }

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

  void startExtensionPull();

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
      main().catch(() => { crashCleanup(); process.exit(1); });
    } else {
      void (async () => {
        if (command === 'restart') {
          const r = await restartDaemon(parseArgs(process.argv).port);
          if (r !== 'start') process.exit(r);
          stopDaemon();
        }
        daemonize(process.argv);
      })();
    }
  } else {
    // No start/restart command: either a query (status/stop/observe) or
    // programmatic spawn (e.g. ensureDaemon) — run main() directly
    main().catch((error) => {
      console.error('Daemon fatal error:', error);
      crashCleanup();
      process.exit(1);
    });
  }
}
