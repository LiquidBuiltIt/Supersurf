"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoggerRegistry = exports.createLog = exports.FileLogger = void 0;
exports.getLogger = getLogger;
exports.getRegistry = getRegistry;
const path_1 = __importDefault(require("path"));
const shared_1 = require("./shared");
// Re-export core types for existing consumers
var shared_2 = require("./shared");
Object.defineProperty(exports, "FileLogger", { enumerable: true, get: function () { return shared_2.FileLogger; } });
const SESSIONS_DIR = path_1.default.join(shared_1.LOG_ROOT, 'sessions');
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
            const logPath = customLogPath ?? path_1.default.join(shared_1.LOG_ROOT, 'server.log');
            this.serverLogger = new shared_1.FileLogger(logPath);
            this.serverLogger.truncate = this._debugMode !== 'no_truncate';
        }
        return this.serverLogger;
    }
    /** Create a session log file and return its logger. */
    setSessionLog(sessionId) {
        // Clean up old logger for same sessionId if it exists
        this.clearSessionLog(sessionId);
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `supersurf-debug-${(0, shared_1.sanitizeFilename)(sessionId)}-${ts}.log`;
        const logPath = path_1.default.join(SESSIONS_DIR, filename);
        const logger = new shared_1.FileLogger(logPath);
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
//# sourceMappingURL=logger.js.map