/**
 * AuditLogger — structured NDJSON audit log for every tool call per session.
 *
 * Always-on (not gated behind DEBUG_MODE). Writes to
 * `~/.supersurf/logs/sessions/audit-{sessionId}-{timestamp}.ndjson`.
 *
 * @module audit-logger
 */
export declare function redactParams(params: Record<string, unknown>): Record<string, unknown>;
export interface AuditEntry {
    ts: string;
    version: string;
    session_id: string;
    tool: string;
    params: Record<string, unknown>;
    result: 'ok' | 'error';
    error?: string;
    url?: string;
    duration_ms: number;
}
export declare class AuditLogger {
    private _path;
    constructor(sessionId: string, auditDir?: string);
    write(entry: Omit<AuditEntry, 'ts' | 'version'>): void;
    getPath(): string;
}
//# sourceMappingURL=audit-logger.d.ts.map