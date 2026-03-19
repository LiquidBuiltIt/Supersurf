/**
 * AuditLogger — structured NDJSON audit log for every tool call per session.
 *
 * Always-on (not gated behind DEBUG_MODE). Writes to
 * `~/.supersurf/logs/sessions/audit-{sessionId}-{timestamp}.ndjson`.
 *
 * @module audit-logger
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const AUDIT_DIR = path.join(os.homedir(), '.supersurf', 'logs', 'sessions');

const SENSITIVE_KEYS = new Set(['value', 'password', 'token', 'secret', 'credential']);

/** Keys whose values are too large to log (base64 blobs, etc.) */
const STRIP_KEYS = new Set(['data']);

export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    const lower = k.toLowerCase();
    if (STRIP_KEYS.has(lower)) continue;
    out[k] = SENSITIVE_KEYS.has(lower) ? '[REDACTED]' : v;
  }
  return out;
}

export interface AuditEntry {
  ts: string;
  session_id: string;
  tool: string;
  params: Record<string, unknown>;
  result: 'ok' | 'error';
  error?: string;
  url?: string;
  duration_ms: number;
}

export class AuditLogger {
  private _path: string;

  constructor(sessionId: string, auditDir?: string) {
    const dir = auditDir ?? AUDIT_DIR;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this._path = path.join(dir, `audit-${safe}-${ts}.ndjson`);
    fs.mkdirSync(dir, { recursive: true });
  }

  write(entry: Omit<AuditEntry, 'ts'>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
      params: redactParams(entry.params),
    });
    fs.appendFileSync(this._path, line + '\n');
  }

  getPath(): string {
    return this._path;
  }
}
