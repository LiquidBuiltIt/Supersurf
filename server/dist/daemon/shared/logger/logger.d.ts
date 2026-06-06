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
export declare const LOG_ROOT: string;
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
/** Truncate a string, replacing the middle with "…" if over limit. */
export declare function truncateString(str: string, maxLen: number): string;
/** JSON.stringify replacer — redacts base64 and very long strings. */
export declare function replacer(_key: string, value: unknown): unknown;
/** Sanitize a string for use as a filename. */
export declare function sanitizeFilename(name: string): string;
//# sourceMappingURL=logger.d.ts.map