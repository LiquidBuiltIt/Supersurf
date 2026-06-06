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
declare const SUPERSURF_DIR: string;
declare const PID_FILE: string;
declare const SOCK_FILE: string;
declare const IDLE_TIMEOUT_MS: number;
declare function parseArgs(argv: string[]): {
    port: number;
    debug: boolean;
    verbose: boolean;
    command?: string;
    portExplicit: boolean;
};
/** Format uptime seconds into human-readable string. */
declare function formatUptime(seconds: number): string;
/** Read package version from package.json */
declare function getVersion(): string;
declare function printStatus(verbose: boolean): Promise<void>;
declare function observe(): void;
/** Stop the running daemon by sending SIGTERM to the PID in the PID file. */
declare function stopDaemon(): boolean;
/** Check if a process with the given PID is alive. */
declare function isProcessAlive(pid: number): boolean;
/** Clean stale PID/socket files if the referenced process is dead. */
declare function cleanStaleFiles(): void;
export { parseArgs, isProcessAlive, cleanStaleFiles, stopDaemon, printStatus, observe, formatUptime, getVersion, SUPERSURF_DIR, PID_FILE, SOCK_FILE, IDLE_TIMEOUT_MS };
//# sourceMappingURL=main.d.ts.map