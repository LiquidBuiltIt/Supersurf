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
import { isProcessAlive } from 'shared';
import { SUPERSURF_DIR, PID_FILE, SOCK_FILE, parseArgs, formatUptime, getVersion, printStatus, observe, stopDaemon } from './cli-commands';
declare const IDLE_TIMEOUT_MS: number;
/** Clean stale PID/socket files if the referenced process is dead. */
declare function cleanStaleFiles(): void;
export { parseArgs, isProcessAlive, cleanStaleFiles, stopDaemon, printStatus, observe, formatUptime, getVersion, SUPERSURF_DIR, PID_FILE, SOCK_FILE, IDLE_TIMEOUT_MS };
//# sourceMappingURL=main.d.ts.map