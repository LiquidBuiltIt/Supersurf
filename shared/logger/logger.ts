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

import fs from 'fs';
import path from 'path';
import os from 'os';

export const LOG_ROOT = path.join(os.homedir(), '.supersurf', 'logs');
const DEFAULT_TRUNCATE_LEN = 120;

/** Debug mode: false (off), 'truncate' (default debug), 'no_truncate' (full payloads). */
export type DebugMode = false | 'truncate' | 'no_truncate';

/**
 * Synchronous, append-only file logger. Writes ISO-timestamped lines and
 * also mirrors to stderr. Truncates the log file on construction to start fresh,
 * unless `opts.maxBytes` is set: then it appends to the existing file and rotates
 * it to `<path>.1` (replacing any older one) when a line would pass the cap.
 */
export class FileLogger {
  logFilePath: string;
  enabled: boolean = false;
  private _truncate: boolean = true;
  private _maxBytes?: number;
  private _size: number = 0;

  constructor(logFilePath: string, opts?: { maxBytes?: number }) {
    this.logFilePath = logFilePath;
    this._maxBytes = opts?.maxBytes;

    const logDir = path.dirname(this.logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    if (this._maxBytes === undefined) {
      if (fs.existsSync(this.logFilePath)) {
        fs.truncateSync(this.logFilePath, 0);
      }
    } else {
      try { this._size = fs.statSync(this.logFilePath).size; } catch { this._size = 0; }
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
    if (this._maxBytes !== undefined) this.rotateIfNeeded(Buffer.byteLength(logLine));
    fs.appendFileSync(this.logFilePath, logLine, 'utf8');
    this._size += Buffer.byteLength(logLine);
    console.error(message);
  }

  /** Move the file to `.1` when `incoming` bytes would pass the cap. A failed rename never throws. */
  private rotateIfNeeded(incoming: number): void {
    if (this._size === 0 || this._size + incoming <= this._maxBytes!) return;
    try {
      fs.renameSync(this.logFilePath, this.logFilePath + '.1');
      this._size = 0;
    } catch {
      // keep appending to the same file rather than lose the line
    }
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

// ─── Helpers ──────────────────────────────────────────────────

/** Truncate a string, replacing the middle with "…" if over limit. */
export function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 3) / 2);
  return str.slice(0, half) + '...' + str.slice(-half);
}

/** JSON.stringify replacer — redacts base64 and very long strings. */
export function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > 200 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 100))) {
      return `[base64 ${value.length} chars]`;
    }
  }
  return value;
}

/** Sanitize a string for use as a filename. */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
