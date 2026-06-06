"use strict";
/**
 * Core file logger — shared across daemon and server packages.
 *
 * Provides:
 *   - **FileLogger** — synchronous, append-only file logger with ISO timestamps
 *   - **DebugMode** — debug mode type (`false | 'truncate' | 'no_truncate'`)
 *   - Truncation helpers and JSON replacer for log-safe output
 *
 * Package-specific concerns (session routing, registries) belong in the
 * consuming package, not here.
 *
 * @module shared/logger
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileLogger = exports.LOG_ROOT = void 0;
exports.truncateString = truncateString;
exports.replacer = replacer;
exports.sanitizeFilename = sanitizeFilename;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
exports.LOG_ROOT = path_1.default.join(os_1.default.homedir(), '.supersurf', 'logs');
const DEFAULT_TRUNCATE_LEN = 120;
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
// ─── Helpers ──────────────────────────────────────────────────
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