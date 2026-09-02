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

import path from 'path';
import { FileLogger, LOG_ROOT, sanitizeFilename } from './logger';
import type { DebugMode } from './logger';

// Re-export core types for existing consumers
export { FileLogger } from './logger';
export type { DebugMode } from './logger';

const SESSIONS_DIR = path.join(LOG_ROOT, 'sessions');

// ─── Session-aware logger registry ──────────────────────────

/**
 * Singleton managing the server logger and per-session loggers.
 * Propagates debug mode (and truncation setting) to all managed loggers.
 */
class LoggerRegistry {
  private serverLogger: FileLogger | null = null;
  private sessionLoggers = new Map<string, FileLogger>();
  private _debugMode: DebugMode = false;

  get debugMode(): DebugMode {
    return this._debugMode;
  }

  set debugMode(mode: DebugMode) {
    this._debugMode = mode;
    // Propagate truncation setting to all loggers
    const truncate = mode !== 'no_truncate';
    if (this.serverLogger) this.serverLogger.truncate = truncate;
    for (const logger of this.sessionLoggers.values()) {
      logger.truncate = truncate;
    }
  }

  /** Get or create the server-level logger. */
  getServerLogger(customLogPath?: string): FileLogger {
    if (!this.serverLogger) {
      const logPath = customLogPath ?? path.join(LOG_ROOT, 'server.log');
      this.serverLogger = new FileLogger(logPath);
      this.serverLogger.truncate = this._debugMode !== 'no_truncate';
    }
    return this.serverLogger;
  }

  /** Create a session log file and return its logger. */
  setSessionLog(sessionId: string): FileLogger {
    // Clean up old logger for same sessionId if it exists
    this.clearSessionLog(sessionId);

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `supersurf-debug-${sanitizeFilename(sessionId)}-${ts}.log`;
    const logPath = path.join(SESSIONS_DIR, filename);

    const logger = new FileLogger(logPath);
    logger.truncate = this._debugMode !== 'no_truncate';
    if (this._debugMode) {
      logger.enable();
      logger.log(`[Session] Session "${sessionId}" started`);
    }
    this.sessionLoggers.set(sessionId, logger);
    return logger;
  }

  /** Close and remove a session logger. */
  clearSessionLog(sessionId: string): void {
    const logger = this.sessionLoggers.get(sessionId);
    if (logger) {
      logger.log(`[Session] Session "${sessionId}" ended`);
      logger.disable();
      this.sessionLoggers.delete(sessionId);
    }
  }

  /** Get session logger if it exists, otherwise fall back to server logger. */
  getLogger(sessionId?: string | null): FileLogger {
    if (sessionId) {
      const sessionLogger = this.sessionLoggers.get(sessionId);
      if (sessionLogger) return sessionLogger;
    }
    return this.getServerLogger();
  }

  /** Reset for testing. */
  reset(): void {
    this.serverLogger = null;
    this.sessionLoggers.clear();
    this._debugMode = false;
  }
}

const registry = new LoggerRegistry();

// ─── Public API ─────────────────────────────────────────────

/** Get the server-level logger (backwards compat). */
export function getLogger(customLogPath?: string): FileLogger {
  return registry.getServerLogger(customLogPath);
}

/** Get the global logger registry for session management. */
export function getRegistry(): LoggerRegistry {
  return registry;
}

/**
 * Factory for prefixed debug loggers.
 * Only outputs when DEBUG_MODE is truthy.
 * If sessionId is provided, routes to that session's log file.
 */
export const createLog = (prefix: string, sessionId?: string | null) =>
  (...args: unknown[]) =>
    (global as any).DEBUG_MODE && registry.getLogger(sessionId).log(prefix, ...args);

export { LoggerRegistry };
