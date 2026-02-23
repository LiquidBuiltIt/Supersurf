/**
 * File Logger -- multi-session debug logging with truncation.
 *
 * Architecture:
 *   - Server log:  `~/.supersurf/logs/server.log`  (always-on backbone)
 *   - Session logs: `~/.supersurf/logs/sessions/supersurf-debug-{clientId}-{timestamp}.log`
 *
 * The logger stays dumb -- it writes to whatever file path it's given.
 * Session routing is handled by the connection lifecycle (enable/disable).
 *
 * Key classes:
 *   - **FileLogger** -- writes timestamped lines to a single file, with optional truncation
 *   - **LoggerRegistry** -- singleton managing server + per-session loggers, propagates debug mode
 *
 * Public API:
 *   - `getLogger()` -- get server-level logger (backwards compat)
 *   - `getRegistry()` -- get the global LoggerRegistry for session management
 *   - `createLog(prefix)` -- factory for prefixed debug loggers (only outputs when DEBUG_MODE is true)
 *
 * @module logger
 */
/** Debug mode: false (off), 'truncate' (default debug), 'no_truncate' (full payloads). */
export type DebugMode = false | 'truncate' | 'no_truncate';
/**
 * Synchronous, append-only file logger. Writes ISO-timestamped lines and
 * also mirrors to stderr. Truncates the log file on construction to start fresh.
 */
export declare class FileLogger {
    logFilePath: string;
    enabled: boolean;
    private _truncate;
    constructor(logFilePath: string);
    get truncate(): boolean;
    set truncate(value: boolean);
    enable(): void;
    disable(): void;
    /** Append a timestamped log line. No-ops if logger is disabled. Also writes to stderr. */
    log(...args: unknown[]): void;
    /** Serialize an argument to a log-safe string, applying truncation if enabled. */
    private formatArg;
}
/**
 * Singleton managing the server logger and per-session loggers.
 * Propagates debug mode (and truncation setting) to all managed loggers.
 */
declare class LoggerRegistry {
    private serverLogger;
    private sessionLoggers;
    private _debugMode;
    get debugMode(): DebugMode;
    set debugMode(mode: DebugMode);
    /** Get or create the server-level logger. */
    getServerLogger(customLogPath?: string): FileLogger;
    /** Create a session log file and return its logger. */
    setSessionLog(sessionId: string): FileLogger;
    /** Close and remove a session logger. */
    clearSessionLog(sessionId: string): void;
    /** Get session logger if it exists, otherwise fall back to server logger. */
    getLogger(sessionId?: string | null): FileLogger;
    /** Reset for testing. */
    reset(): void;
}
/** Get the server-level logger (backwards compat). */
export declare function getLogger(customLogPath?: string): FileLogger;
/** Get the global logger registry for session management. */
export declare function getRegistry(): LoggerRegistry;
/**
 * Factory for prefixed debug loggers.
 * Only outputs when DEBUG_MODE is truthy.
 * If sessionId is provided, routes to that session's log file.
 */
export declare const createLog: (prefix: string, sessionId?: string | null) => (...args: unknown[]) => any;
export { LoggerRegistry };
//# sourceMappingURL=logger.d.ts.map