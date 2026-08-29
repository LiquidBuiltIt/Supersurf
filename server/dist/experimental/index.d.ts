/**
 * ExperimentRegistry — cache-backed IPC proxy for experiment state.
 *
 * The daemon owns experiment state. This registry caches enabled/disabled
 * flags locally for synchronous reads (isEnabled) and IPCs toggle operations
 * to the daemon. Processing logic (page diffing, AST analysis, waypoint
 * generation) remains server-side.
 *
 * @module experimental/index
 *
 * Key exports:
 * - {@link experimentRegistry} — singleton registry instance
 * - {@link applyInitialState} — pre-enable experiments from startup config
 * - {@link getExperimentalToolSchemas} — collect MCP tool schemas from experimental modules
 * - {@link callExperimentalTool} — route experimental tool calls to handlers
 */
export { diffSnapshots, calculateConfidence, formatDiffSection } from './page-diffing';
export type { PageState, DiffResult } from './page-diffing';
import type { ToolSchema, ToolContext } from '../tools/lib/types';
import type { IExtensionTransport } from '../bridge';
import type { Config } from 'shared';
/**
 * Cache-backed IPC proxy for experiment state, keyed by MCP session id.
 *
 * Reads are synchronous (from the session's local cache). Writes IPC to the
 * daemon over that session's transport and update its cache on success.
 *
 * The session id is the `client_id` passed to `connect`, which the daemon
 * already enforces as unique (`daemon/src/ipc.ts` rejects duplicates with
 * 'Session ID already in use'). Two ConnectionManagers in one process
 * therefore get two slots and cannot clobber each other.
 *
 * `isEnabled(feature)` / `getStates()` with no session id fall back to a
 * union across all bound sessions. That fallback exists only for the ~15
 * reader call sites in tools/ and experimental/fingerprinting/ that have no
 * session handle yet; threading it through is BACKLOG #20. In practice the
 * union and the per-session answer agree, because every session pre-enables
 * from the same `~/.supersurf/config.json` snapshot via `applyInitialState`.
 */
declare class ExperimentRegistry {
    private _sessions;
    /** Get-or-create the slot for a session id. */
    private _slot;
    /** Guard a feature name against AVAILABLE_EXPERIMENTS. */
    private _assertAvailable;
    /** Fire-and-forget IPC + local cache write for one session. */
    private _set;
    /** Bind a session to its daemon transport. Called on connect. */
    bind(sessionId: string, transport: IExtensionTransport): void;
    /** Drop a session's transport and cached flags. Called on disconnect. */
    unbind(sessionId: string): void;
    /**
     * Toggle an experiment for one session. IPCs to the daemon over that
     * session's transport, then updates its local cache. Reserved for
     * programmatic use; v2 disables session-level toggling via MCP
     * (experiments come from `~/.supersurf/config.json`).
     */
    toggle(sessionId: string, feature: string, enabled: boolean): Promise<void>;
    /**
     * Enable an experiment for one session. Fire-and-forget IPC.
     * Throws if the name is not in AVAILABLE_EXPERIMENTS.
     */
    enable(sessionId: string, feature: string): void;
    /**
     * Disable an experiment for one session. Fire-and-forget IPC.
     * Throws if the name is not in AVAILABLE_EXPERIMENTS.
     */
    disable(sessionId: string, feature: string): void;
    /**
     * Returns true only if the experiment is enabled in the cache. Sync — no IPC.
     * With `sessionId`, reads that session alone. Without it, returns true when
     * any bound session has the flag on.
     */
    isEnabled(feature: string, sessionId?: string): boolean;
    /** Clear every session slot. Test hook and process-wide reset. */
    reset(): void;
    /** Return a copy of all recognized experiment names. */
    listAvailable(): string[];
    /** Snapshot of all experiments for one session, or the union across sessions. */
    getStates(sessionId?: string): Record<string, boolean>;
    /** Check if a feature name is recognized (exists in AVAILABLE_EXPERIMENTS). */
    isAvailable(feature: string): boolean;
}
export declare const experimentRegistry: ExperimentRegistry;
/**
 * Pre-enable one session's features from a Config experiments snapshot.
 * Silently skips feature names that aren't in AVAILABLE_EXPERIMENTS
 * (notably `profiles`, which is a daemon-startup flag, not session-toggleable).
 * Fire-and-forget IPCs to the daemon for each enabled experiment.
 */
export declare function applyInitialState(sessionId: string, experiments: Config['experiments']): void;
/** Collect schemas from all experimental tool modules */
export declare function getExperimentalToolSchemas(): ToolSchema[];
/**
 * Try to dispatch a tool call to an experimental handler.
 * Returns the result if handled, or null if the tool name isn't experimental.
 */
export declare function callExperimentalTool(name: string, ctx: ToolContext, args: Record<string, unknown>, options: {
    rawResult?: boolean;
}): Promise<any | null>;
//# sourceMappingURL=index.d.ts.map