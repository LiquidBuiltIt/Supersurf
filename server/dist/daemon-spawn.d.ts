/**
 * Daemon lifecycle utilities — spawn, detect, and connect to the daemon process.
 *
 * @module daemon-spawn
 * @exports isDaemonRunning - Check if daemon process is alive
 * @exports ensureDaemon - Spawn daemon if not running, wait for socket
 * @exports stopDaemon - Stop the daemon and remove stale socket/PID files
 * @exports getSockPath - Return the daemon socket path
 * @exports getPidPath - Return the daemon PID file path
 */
/**
 * Turn a captured daemon-startup-stderr blob into a single human-facing reason.
 * Recognizes the common wedged-port case (EADDRINUSE) and renders an actionable
 * message; otherwise returns the last non-empty line, or null if nothing useful.
 */
export declare function explainStartupFailure(raw: string, port: number): string | null;
/** Return the path to the daemon's Unix socket. */
export declare function getSockPath(): string;
/** Return the path to the daemon's PID file. */
export declare function getPidPath(): string;
/**
 * Check if the daemon process is currently running.
 * Reads the PID file and verifies the process is alive.
 */
export declare function isDaemonRunning(): boolean;
/**
 * Stop the daemon: SIGTERM the PID-file process, wait up to 5s for exit,
 * SIGKILL as a last resort, then remove stale socket/PID files.
 * Safe no-op when nothing is running.
 */
export declare function stopDaemon(): Promise<void>;
/**
 * Resolve the daemon entry script. The daemon ships as a SEPARATE package
 * (`supersurf-daemon`), declared as a dependency of supersurf-mcp, so it
 * resolves from node_modules in a published install and via the workspace
 * symlink in local dev. Never fetched from the network, never bundled.
 */
export declare function resolveDaemonEntry(): string;
/**
 * Ensure the daemon is running. If not, spawn it and wait for the socket file.
 *
 * @param port - WebSocket port for the extension connection (default 5555)
 * @param debug - Enable daemon debug logging
 * @throws If daemon fails to start within 10 seconds
 */
export declare function ensureDaemon(port?: number, debug?: boolean, experiments?: string[]): Promise<void>;
//# sourceMappingURL=daemon-spawn.d.ts.map