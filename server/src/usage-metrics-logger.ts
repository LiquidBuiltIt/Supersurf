/**
 * UsageMetricsLogger — structured NDJSON usage-metrics log for every tool call per session.
 *
 * Gated by `config.logging.usage_metrics` (default true in scaffolded config,
 * false in raw hardcoded defaults). Writes to
 * `~/.supersurf/logs/sessions/metrics-{sessionId}-{timestamp}.ndjson`.
 *
 * Renamed from `AuditLogger` in v2.0.0; older logs are at `audit-*.ndjson`.
 *
 * @module usage-metrics-logger
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

const METRICS_DIR = path.join(os.homedir(), '.supersurf', 'logs', 'sessions');

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

export interface MetricsEntry {
  ts: string;
  version: string;
  session_id: string;
  tool: string;
  params: Record<string, unknown>;
  result: 'ok' | 'error';
  error?: string;
  url?: string;
  duration_ms: number;
  tip?: string;
  client?: { name: string; version: string };
  experiments?: Record<string, boolean>;
}

export class UsageMetricsLogger {
  readonly filePath: string;

  constructor(sessionId: string, metricsDir?: string) {
    const dir = metricsDir ?? METRICS_DIR;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.filePath = path.join(dir, `metrics-${safe}-${ts}.ndjson`);
    fs.mkdirSync(dir, { recursive: true });
  }

  write(entry: Omit<MetricsEntry, 'ts' | 'version'>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      version: PKG_VERSION,
      ...entry,
      params: redactParams(entry.params),
    });
    fs.appendFileSync(this.filePath, line + '\n');
  }

  /** @deprecated Use the readonly `filePath` field. Kept for callers transitioning from v1.x. */
  getPath(): string {
    return this.filePath;
  }
}
