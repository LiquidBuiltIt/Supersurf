/**
 * DaemonExperimentRegistry — per-session experiment state owned by the daemon.
 *
 * The daemon is the source of truth for which experiments are enabled per session.
 * MCP servers query/toggle experiment state via IPC messages (experiments.toggle,
 * experiments.get, experiments.getOne) and cache results locally.
 *
 * @module experiments/index
 */
import type { Config } from 'shared';
export interface DaemonExperimentRegistryOptions {
    /** Resolved experiments snapshot from ConfigService. */
    defaults?: Config['experiments'];
}
/**
 * Per-session experiment state registry.
 *
 * Stores which experiments each MCP session has enabled. Sessions that haven't
 * explicitly toggled anything inherit from defaults injected at construction
 * time (from ConfigService, which merges file + env + CLI inputs).
 */
export declare class DaemonExperimentRegistry {
    /** sessionId → Set of enabled experiment names */
    private _sessions;
    /** Experiments pre-enabled by injected config snapshot. */
    private _defaults;
    constructor(opts?: DaemonExperimentRegistryOptions);
    /**
     * Apply experiment defaults. Retained for backwards compatibility with
     * call sites that supply a string list (e.g., tests). New code should
     * inject defaults via the constructor.
     */
    applyDefaults(experiments: string[]): void;
    /**
     * Toggle an experiment for a session.
     * Lazy-initializes the session's Set from defaults on first access.
     */
    toggle(sessionId: string, experiment: string, enabled: boolean): boolean;
    /** Check if an experiment is enabled for a session. */
    isEnabled(sessionId: string, experiment: string): boolean;
    /** Get all experiment states for a session. */
    getAll(sessionId: string): Record<string, boolean>;
    /** Clean up a session's experiment state. */
    deleteSession(sessionId: string): void;
    /** Initialize a session with defaults. No-op if already initialized. */
    initSession(sessionId: string): void;
    /** Check if an experiment name is recognized. */
    isAvailable(experiment: string): boolean;
    /** Return all recognized experiment names. */
    listAvailable(): readonly string[];
}
//# sourceMappingURL=index.d.ts.map