/**
 * ActionTrail — the in-memory record of every browser action this MCP session
 * performed, each with a monotonic id the agent can cite when building a playbook.
 *
 * LIFETIME: module-level singleton, so it lives exactly as long as the server
 * process. One server process serves exactly one MCP client for its whole life
 * (`cli.ts` connects a single StdioServerTransport with no accept loop), so
 * module scope IS session scope. Ids therefore never reset mid-conversation —
 * an id the agent saw an hour ago still means the same action.
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
export declare const actionTrail: ActionTrail;
export {};
//# sourceMappingURL=trail.d.ts.map