/**
 * Server logger — session-aware registry built on shared FileLogger.
 *
 * Architecture:
 *   - Server log:  `~/.supersurf/logs/server.log`  (always-on backbone)
 *   - Session logs: `~/.supersurf/logs/sessions/supersurf-debug-{clientId}-{timestamp}.log`
 *
 * Key classes:
 *   - **FileLogger** (from shared) -- writes timestamped lines to a single file
 *   - **LoggerRegistry** -- singleton managing server + per-session loggers
 *
 * Public API:
 *   - `getLogger()` -- get server-level logger (backwards compat)
 *   - `getRegistry()` -- get the global LoggerRegistry for session management
 *   - `createLog(prefix)` -- factory for prefixed debug loggers (only outputs when DEBUG_MODE is true)
 *
 * @module logger
 */
import { FileLogger } from './logger';
import type { DebugMode } from './logger';
export { FileLogger } from './logger';
export type { DebugMode } from './logger';
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
//# sourceMappingURL=registry.d.ts.map