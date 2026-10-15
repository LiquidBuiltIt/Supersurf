/**
 * ActionTrail — the in-memory record of every browser action this agent session
 * performed, each with a monotonic id the agent can cite when building a playbook.
 *
 * LIFETIME: one trail per agent session, keyed by its username (`trailFor`),
 * dropped on disconnect (`dropTrail`). Ids never reset mid-conversation —
 * an id the agent saw an hour ago still means the same action — and one agent's
 * ids and tips never see another agent's actions.
 *
 * NOT the usage-metrics logger. That trail is gated by `logging.usage_metrics`
 * (default off) and redacts `value`, which would reconstruct a `select_option`
 * step as `[REDACTED]`. This one is always on and keeps params intact, because
 * `run` has to re-issue them.
 *
 * @module playbooks/trail
 */
import type { TrailEntry, TrailInput } from './types';
declare class ActionTrail {
    private _nextId;
    private _entries;
    /**
     * Record an action and return its freshly minted id.
     *
     * The id counter is independent of the retention buffer: evicting old entries
     * never rewinds the counter, so a cited-but-evicted id resolves to "not found"
     * rather than silently hitting a different action.
     */
    record(input: TrailInput): number;
    /** Look up one entry by id. Undefined when unknown or evicted. */
    get(id: number): TrailEntry | undefined;
    /**
     * Most-recent-first window, returned in ascending id order for display.
     * `offset` pages backwards: offset 0 is the newest `limit` entries.
     */
    tail(limit: number, offset?: number): {
        entries: TrailEntry[];
        total: number;
    };
    size(): number;
    /** Test-only. Do not call from production code. */
    _resetForTest(): void;
}
/** The trail of one agent session. `null` (script mode before connect) gets its own bucket. */
export declare function trailFor(sessionId: string | null | undefined): ActionTrail;
export declare function dropTrail(sessionId: string): void;
/** @internal */
export declare function _resetTrailsForTest(): void;
export {};
//# sourceMappingURL=trail.d.ts.map