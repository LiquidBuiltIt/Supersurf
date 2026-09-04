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
 * failure, so `SelectorMiss` alone captures a ranked candidate-selector list
 * before the run's tab closes; the other five error types carry no evidence.
 *
 * Every write is best-effort. A bookkeeping failure must never turn a
 * successful run into a reported failure.
 *
 * @module playbooks/runs
 */
import type { PlaybookErrorType, FailureAt } from './errors';
import type { Candidate } from './candidates';
/**
 * Cap on the stored `evidence` object. A sidecar that outgrows its script helps
 * nobody — and the uncapped accessibility tree this replaces reached 766 KB for
 * a single failed selector.
 */
export declare const MAX_EVIDENCE_CHARS = 4000;
/** Spec §7.8. */
export interface RunRecord {
    ts: number;
    params: Record<string, unknown>;
    ok: boolean;
    error?: string;
    /** Which KIND of failure — see `playbooks/errors.ts`. Absent on success. */
    type?: PlaybookErrorType;
    /** Which command threw, and its 1-based index in the run. */
    at?: FailureAt;
    /** The in-child stack, persisted for every in-child throw. */
    stack?: string;
    durationMs: number;
    profile?: string;
    caller: 'agent' | 'cli';
    /**
     * Did this run activate `meta.experiments` (Addendum B)? Recorded so a
     * failure can be attributed to the experimental path. Without it, an
     * experiment-only regression looks identical to a broken script.
     */
    experiments: boolean;
    /**
     * `SelectorMiss` only. A record written before the taxonomy carries a
     * `snapshot` string here instead; readers must tolerate both.
     */
    evidence?: {
        url?: string;
        title?: string;
        candidates?: Candidate[];
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