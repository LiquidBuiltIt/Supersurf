/**
 * The per-playbook run sidecar (spec §7.8) — `<name>.runs.jsonl`, append-only
 * NDJSON beside the script.
 *
 * Deliberately NOT derived from the usage-metrics trail: that trail is
 * session-scoped and gated behind `logging.usage_metrics`, which defaults off,
 * so a playbook's history would evaporate between sessions.
 *
 * `evidence` exists because the runner owns its tab and CLOSES it at exit
 * (spec §10 risk 2). A failing script destroys the page that would explain the
 * failure, so the snapshot is taken on the throw, before teardown.
 *
 * Every write is best-effort. A bookkeeping failure must never turn a
 * successful run into a reported failure.
 *
 * @module playbooks/runs
 */
/** Cap on a stored snapshot. A sidecar that outgrows its script helps nobody. */
export declare const MAX_EVIDENCE_CHARS = 4000;
/** Spec §7.8. */
export interface RunRecord {
    ts: number;
    params: Record<string, unknown>;
    ok: boolean;
    error?: string;
    durationMs: number;
    profile?: string;
    caller: 'agent' | 'cli';
    /**
     * Did this run activate `meta.experiments` (Addendum B)? Recorded so a
     * failure can be attributed to the experimental path. Without it, an
     * experiment-only regression looks identical to a broken script.
     */
    experiments: boolean;
    evidence?: {
        snapshot?: string;
    };
}
/** Append one record. Never throws. */
export declare function appendRunRecord(name: string, rec: RunRecord): void;
/** Newest first, capped at `limit`. Malformed lines are skipped, not fatal. */
export declare function readRunRecords(name: string, limit?: number): RunRecord[];
/** One-line history summary for `list` / `inspect`. */
export declare function formatRunSummary(recs: RunRecord[]): string;
//# sourceMappingURL=runs.d.ts.map