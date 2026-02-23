"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoggerRegistry = exports.createLog = exports.FileLogger = void 0;
exports.getLogger = getLogger;
exports.getRegistry = getRegistry;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const LOG_ROOT = path_1.default.join(os_1.default.homedir(), '.supersurf', 'logs');
const SESSIONS_DIR = path_1.default.join(LOG_ROOT, 'sessions');
const DEFAULT_TRUNCATE_LEN = 120;
// ─── FileLogger ─────────────────────────────────────────────
/**
 * Synchronous, append-only file logger. Writes ISO-timestamped lines and
 * also mirrors to stderr. Truncates the log file on construction to start fresh.
 */
class FileLogger {
    logFilePath;
    enabled = false;
    _truncate = true;
    constructor(logFilePath) {
        this.logFilePath = logFilePath;
        const logDir = path_1.default.dirname(this.logFilePath);
        if (!fs_1.default.existsSync(logDir)) {
            fs_1.default.mkdirSync(logDir, { recursive: true });
        }
        if (fs_1.default.existsSync(this.logFilePath)) {
            fs_1.default.truncateSync(this.logFilePath, 0);
        }
    }
    get truncate() {
        return this._truncate;
    }
    set truncate(value) {
        this._truncate = value;
    }
    enable() {
        this.enabled = true;
        this.log('[FileLogger] Logging enabled — writing to:', this.logFilePath);
    }
    disable() {
        this.enabled = false;
    }
    /** Append a timestamped log line. No-ops if logger is disabled. Also writes to stderr. */
    log(...args) {
        if (!this.enabled)
            return;
        const timestamp = new Date().toISOString();
        const message = args
            .map((arg) => this.formatArg(arg))
            .join(' ');
        const logLine = `[${timestamp}] ${message}\n`;
        fs_1.default.appendFileSync(this.logFilePath, logLine, 'utf8');
        console.error(message);
    }
    /** Serialize an argument to a log-safe string, applying truncation if enabled. */
    formatArg(arg) {
        if (typeof arg === 'string') {
            return this._truncate ? truncateString(arg, DEFAULT_TRUNCATE_LEN) : arg;
        }
        if (typeof arg === 'object' && arg !== null) {
            try {
                const json = JSON.stringify(arg, replacer, 2);
                return this._truncate ? truncateString(json, DEFAULT_TRUNCATE_LEN * 4) : json;
            }
            catch {
                return String(arg);
            }
        }
        return String(arg);
    }
}
exports.FileLogger = FileLogger;
// ─── Session-aware logger registry ──────────────────────────
/**
 * Singleton managing the server logger and per-session loggers.
 * Propagates debug mode (and truncation setting) to all managed loggers.
 */
class LoggerRegistry {
    serverLogger = null;
    sessionLoggers = new Map();
    _debugMode = false;
    get debugMode() {
        return this._debugMode;
    }
    set debugMode(mode) {
        this._debugMode = mode;
        // Propagate truncation setting to all loggers
        const truncate = mode !== 'no_truncate';
        if (this.serverLogger)
            this.serverLogger.truncate = truncate;
        for (const logger of this.sessionLoggers.values()) {
            logger.truncate = truncate;
        }
    }
    /** Get or create the server-level logger. */
    getServerLogger(customLogPath) {
        if (!this.serverLogger) {
            const logPath = customLogPath ?? path_1.default.join(LOG_ROOT, 'server.log');
            this.serverLogger = new FileLogger(logPath);
            this.serverLogger.truncate = this._debugMode !== 'no_truncate';
        }
        return this.serverLogger;
    }
    /** Create a session log file and return its logger. */
    setSessionLog(sessionId) {
        // Clean up old logger for same sessionId if it exists
        this.clearSessionLog(sessionId);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `supersurf-debug-${sanitizeFilename(sessionId)}-${ts}.log`;
        const logPath = path_1.default.join(SESSIONS_DIR, filename);
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
    clearSessionLog(sessionId) {
        const logger = this.sessionLoggers.get(sessionId);
        if (logger) {
            logger.log(`[Session] Session "${sessionId}" ended`);
            logger.disable();
            this.sessionLoggers.delete(sessionId);
        }
    }
    /** Get session logger if it exists, otherwise fall back to server logger. */
    getLogger(sessionId) {
        if (sessionId) {
            const sessionLogger = this.sessionLoggers.get(sessionId);
            if (sessionLogger)
                return sessionLogger;
        }
        return this.getServerLogger();
    }
    /** Reset for testing. */
    reset() {
        this.serverLogger = null;
        this.sessionLoggers.clear();
        this._debugMode = false;
    }
}
exports.LoggerRegistry = LoggerRegistry;
const registry = new LoggerRegistry();
// ─── Public API ─────────────────────────────────────────────
/** Get the server-level logger (backwards compat). */
function getLogger(customLogPath) {
    return registry.getServerLogger(customLogPath);
}
/** Get the global logger registry for session management. */
function getRegistry() {
    return registry;
}
/**
 * Factory for prefixed debug loggers.
 * Only outputs when DEBUG_MODE is truthy.
 * If sessionId is provided, routes to that session's log file.
 */
const createLog = (prefix, sessionId) => (...args) => global.DEBUG_MODE && registry.getLogger(sessionId).log(prefix, ...args);
exports.createLog = createLog;
// ─── Truncation helpers ─────────────────────────────────────
/** Truncate a string, replacing the middle with "…" if over limit. */
function truncateString(str, maxLen) {
    if (str.length <= maxLen)
        return str;
    const half = Math.floor((maxLen - 3) / 2);
    return str.slice(0, half) + '...' + str.slice(-half);
}
/** JSON.stringify replacer — redacts base64 and very long strings. */
function replacer(_key, value) {
    if (typeof value === 'string') {
        // Detect base64 data (screenshots, PDFs)
        if (value.length > 200 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 100))) {
            return `[base64 ${value.length} chars]`;
        }
    }
    return value;
}
/** Sanitize a string for use as a filename. */
function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
//# sourceMappingURL=logger.js.map