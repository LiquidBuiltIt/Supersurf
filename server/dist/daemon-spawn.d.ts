/**
 * Daemon lifecycle utilities — spawn, detect, and connect to the daemon process.
 *
 * @module daemon-spawn
 * @exports isDaemonRunning - Check if daemon process is alive
 * @exports ensureDaemon - Spawn daemon if not running, wait for socket
 * @exports getSockPath - Return the daemon socket path
 * @exports getPidPath - Return the daemon PID file path
 */
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
 * Ensure the daemon is running. If not, spawn it and wait for the socket file.
 *
 * @param port - WebSocket port for the extension connection (default 5555)
 * @param debug - Enable daemon debug logging
 * @throws If daemon fails to start within 10 seconds
 */
export declare function ensureDaemon(port?: number, debug?: boolean, experiments?: string[]): Promise<void>;
//# sourceMappingURL=daemon-spawn.d.ts.map