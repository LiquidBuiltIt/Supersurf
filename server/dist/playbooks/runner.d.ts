/**
 * The playbook run lifecycle.
 *
 * A run gets its OWN daemon session and its OWN tab, and the tab is CLOSED at
 * the end. `client_id` IS the daemon session id — `daemon/src/ipc.ts:144-151`
 * rejects a duplicate with `Session ID already in use` — so the run's id must
 * differ from the parent's. The parent is whichever process holds a
 * `ConnectionManager`: the MCP server or the CLI. Never the daemon.
 *
 * Because the tab dies at exit (spec §10 risk 2), a failed run captures a
 * snapshot BEFORE teardown and stores it as `evidence` on the run record.
 * Skip that and every failure reads as "it broke, no idea why".
 *
 * @module playbooks/runner
 */
import { type PlaybookRunOptions, type PlaybookRunResult } from '../security/sandbox/host';
import type { PlaybookMeta } from '../security/meta';
import type { ValidationRecord } from '../security/validate';
/** The sandbox-host entrypoint, seam-able for unit tests. */
type RunScript = (opts: PlaybookRunOptions) => Promise<PlaybookRunResult>;
/** The slice of `ConnectionManager` a run needs. Narrow so tests can fake it. */
export interface RunnerBackend {
    callTool(name: string, args: Record<string, unknown>, options?: {
        rawResult?: boolean;
    }): Promise<any>;
}
export interface RunPlaybookOptions {
    record: ValidationRecord;
    params: Record<string, unknown>;
    caller: 'agent' | 'cli';
    /** Overrides `meta.profile`, which is only a default. */
    profile?: string;
    onLog?: (msg: string) => void;
    /** Test seams. */
    createBackend?: () => RunnerBackend;
    runScript?: RunScript;
    /** Test seam for Addendum B activation. Receives this run's `client_id`. */
    enableExperiments?: (clientId: string) => void;
}
export interface RunOutcome {
    ok: boolean;
    result?: unknown;
    error?: string;
    durationMs: number;
    logs: string[];
    evidence?: {
        snapshot?: string;
    };
}
/**
 * Addendum B activation. Enables every name in `AVAILABLE_EXPERIMENTS` for THIS
 * RUN'S SESSION ONLY.
 *
 * Two hard rules, both load-bearing:
 *   1. It MUST NOT write `~/.supersurf/config.json`. A playbook is not allowed
 *      to change the user's persistent configuration; the flag dies with the run.
 *   2. It MUST NOT touch the calling agent's session. Plan 1's session-scoped
 *      registry is what makes that true, which is why this fires only after the
 *      run's own `connect` has established its own session.
 *
 * Signatures are Plan 1's, not today's. `listAvailable(): string[]` is the
 * enumerator (there is no `list()`), and after Plan 1 the MUTATORS are
 * session-first — `enable(sessionId, feature)` — while the READERS keep
 * `feature` first with an optional trailing session id. Passing a feature name
 * into the sessionId slot compiles and silently does nothing.
 *
 * The `initHumanization` call is NOT optional. Plan 1's `onConnect` gates
 * `initHumanization(clientId)` behind `isEnabled('mouse_humanization', clientId)`
 * evaluated DURING connect, and we enable AFTER connect. Without this line the
 * humanization session is never created, `generateMovement` throws,
 * `moveCursorTo` swallows it, and every mouse move in the run degrades to a raw
 * CDP teleport — the exact bug Plan 1 exists to fix, reintroduced for playbook
 * runs only.
 */
export declare function defaultEnableExperiments(clientId: string): void;
/**
 * Check the caller's arguments against `meta.params`. Returns an error string
 * or null. Unknown keys are an error, not a silent drop — a typo'd param name
 * that vanishes is the worst kind of bug to chase.
 */
export declare function validateParams(meta: PlaybookMeta, params: Record<string, unknown>): string | null;
export declare function runPlaybook(opts: RunPlaybookOptions): Promise<RunOutcome>;
export {};
//# sourceMappingURL=runner.d.ts.map