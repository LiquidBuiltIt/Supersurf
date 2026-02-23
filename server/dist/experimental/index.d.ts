/**
 * ExperimentRegistry — session-scoped feature flag registry for experimental features.
 *
 * Manages the lifecycle of toggleable experiments (page_diffing, smart_waiting,
 * storage_inspection, mouse_humanization, secure_eval). Experiments are toggled
 * per-session via the `experimental_features` MCP tool.
 *
 * Also serves as the dispatch layer for experimental tools — collects schemas
 * and routes tool calls to their respective handlers.
 *
 * @module experimental/index
 *
 * Key exports:
 * - {@link experimentRegistry} — singleton registry instance
 * - {@link isInfraExperimentEnabled} — check env-var-gated infrastructure experiments
 * - {@link applyInitialState} — pre-enable experiments from startup config
 * - {@link getExperimentalToolSchemas} — collect MCP tool schemas from experimental modules
 * - {@link callExperimentalTool} — route experimental tool calls to handlers
 */
export { diffSnapshots, calculateConfidence, formatDiffSection } from './page-diffing';
export type { PageState, DiffResult } from './page-diffing';
export { analyzeCode, wrapWithPageProxy } from './secure-eval';
export type { AnalysisResult } from './secure-eval';
import type { ToolSchema, ToolContext } from '../tools/types';
/**
 * Session-scoped feature flag registry.
 *
 * Tracks which experiments are currently enabled. Validation ensures only
 * recognized experiment names can be toggled — unknown names throw immediately
 * to surface typos at the call site.
 */
declare class ExperimentRegistry {
    private _enabled;
    /** Enable an experiment. Throws if the name is not in AVAILABLE_EXPERIMENTS. */
    enable(feature: string): void;
    /** Disable an experiment. Throws if the name is not in AVAILABLE_EXPERIMENTS. */
    disable(feature: string): void;
    /** Returns true only if the experiment has been explicitly enabled. */
    isEnabled(feature: string): boolean;
    /** Clear all experiment states (used in tests and session teardown). */
    reset(): void;
    /** Return a copy of all recognized experiment names. */
    listAvailable(): string[];
    /** Return a snapshot of all experiments and their current enabled/disabled state. */
    getStates(): Record<string, boolean>;
    /** Check if a feature name is recognized (exists in AVAILABLE_EXPERIMENTS). */
    isAvailable(feature: string): boolean;
}
export declare const experimentRegistry: ExperimentRegistry;
/**
 * Check if an infrastructure-level experiment (e.g. "multiplexer") is enabled via env var.
 * Infrastructure experiments are gated at startup, not session-toggleable.
 */
export declare function isInfraExperimentEnabled(feature: string, config: {
    enabledExperiments?: string[];
}): boolean;
/**
 * Pre-enable session features listed in the env var config.
 * Silently skips infra features (like "multiplexer") that aren't in AVAILABLE_EXPERIMENTS.
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