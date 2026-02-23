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

import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_ROOT = path.join(os.homedir(), '.supersurf', 'logs');
const SESSIONS_DIR = path.join(LOG_ROOT, 'sessions');
const DEFAULT_TRUNCATE_LEN = 120;

// ─── Types ──────────────────────────────────────────────────

/** Debug mode: false (off), 'truncate' (default debug), 'no_truncate' (full payloads). */
export type DebugMode = false | 'truncate' | 'no_truncate';

// ─── FileLogger ─────────────────────────────────────────────

/**
 * Synchronous, append-only file logger. Writes ISO-timestamped lines and
 * also mirrors to stderr. Truncates the log file on construction to start fresh.
 */
export class FileLogger {
  logFilePath: string;
  enabled: boolean = false;
  private _truncate: boolean = true;

  constructor(logFilePath: string) {
    this.logFilePath = logFilePath;

    const logDir = path.dirname(this.logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    if (fs.existsSync(this.logFilePath)) {
      fs.truncateSync(this.logFilePath, 0);
    }
  }

  get truncate(): boolean {
    return this._truncate;
  }

  set truncate(value: boolean) {
    this._truncate = value;
  }

  enable(): void {
    this.enabled = true;
    this.log('[FileLogger] Logging enabled — writing to:', this.logFilePath);
  }

  disable(): void {
    this.enabled = false;
  }

  /** Append a timestamped log line. No-ops if logger is disabled. Also writes to stderr. */
  log(...args: unknown[]): void {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    const message = args
      .map((arg) => this.formatArg(arg))
      .join(' ');

    const logLine = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(this.logFilePath, logLine, 'utf8');
    console.error(message);
  }

  /** Serialize an argument to a log-safe string, applying truncation if enabled. */
  private formatArg(arg: unknown): string {
    if (typeof arg === 'string') {
      return this._truncate ? truncateString(arg, DEFAULT_TRUNCATE_LEN) : arg;
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        const json = JSON.stringify(arg, replacer, 2);
        return this._truncate ? truncateString(json, DEFAULT_TRUNCATE_LEN * 4) : json;
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }
}

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

// ─── Truncation helpers ─────────────────────────────────────

/** Truncate a string, replacing the middle with "…" if over limit. */
function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 3) / 2);
  return str.slice(0, half) + '...' + str.slice(-half);
}

/** JSON.stringify replacer — redacts base64 and very long strings. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    // Detect base64 data (screenshots, PDFs)
    if (value.length > 200 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 100))) {
      return `[base64 ${value.length} chars]`;
    }
  }
  return value;
}

/** Sanitize a string for use as a filename. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export { LoggerRegistry };
