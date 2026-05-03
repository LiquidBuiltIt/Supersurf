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
/**
 * Cache-backed IPC proxy for experiment state.
 *
 * Reads are synchronous (from local cache). Writes IPC to the daemon and
 * update the cache on success. The ~20 isEnabled() call sites in tools/
 * remain unchanged — same sync signature, same behavior.
 */
declare class ExperimentRegistry {
    private _cache;
    private _transport;
    /** Bind to a daemon transport. Called on connect. */
    bind(transport: IExtensionTransport): void;
    /** Unbind transport and clear cache. Called on disconnect. */
    unbind(): void;
    /**
     * Toggle an experiment. IPCs to daemon, then updates local cache.
     * Use this from the experimental_features handler (async context).
     */
    toggle(feature: string, enabled: boolean): Promise<void>;
    /**
     * Enable an experiment. Fire-and-forget IPC for backwards compat with applyInitialState.
     * Throws if the name is not in AVAILABLE_EXPERIMENTS.
     */
    enable(feature: string): void;
    /**
     * Disable an experiment. Fire-and-forget IPC for backwards compat.
     * Throws if the name is not in AVAILABLE_EXPERIMENTS.
     */
    disable(feature: string): void;
    /** Returns true only if the experiment is enabled in the local cache. Sync — no IPC. */
    isEnabled(feature: string): boolean;
    /** Clear local cache. Daemon handles session cleanup on disconnect. */
    reset(): void;
    /** Return a copy of all recognized experiment names. */
    listAvailable(): string[];
    /** Return a snapshot of all experiments and their current cached state. */
    getStates(): Record<string, boolean>;
    /** Check if a feature name is recognized (exists in AVAILABLE_EXPERIMENTS). */
    isAvailable(feature: string): boolean;
}
export declare const experimentRegistry: ExperimentRegistry;
/**
 * Pre-enable session features listed in the env var config.
 * Silently skips feature names that aren't in AVAILABLE_EXPERIMENTS.
 * Fire-and-forget IPCs to daemon for each enabled experiment.
 */
export declare function applyInitialState(config: {
    enabledExperiments?: string[];
}): void;
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