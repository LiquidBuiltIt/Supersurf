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
export declare function redactParams(params: Record<string, unknown>): Record<string, unknown>;
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
    client?: {
        name: string;
        version: string;
    };
    experiments?: Record<string, boolean>;
}
export declare class UsageMetricsLogger {
    readonly filePath: string;
    constructor(sessionId: string, metricsDir?: string);
    write(entry: Omit<MetricsEntry, 'ts' | 'version'>): void;
    /** @deprecated Use the readonly `filePath` field. Kept for callers transitioning from v1.x. */
    getPath(): string;
}
//# sourceMappingURL=usage-metrics-logger.d.ts.map