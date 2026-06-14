"use strict";
/**
 * DaemonExperimentRegistry — per-session experiment state owned by the daemon.
 *
 * The daemon is the source of truth for which experiments are enabled per session.
 * MCP servers query/toggle experiment state via IPC messages (experiments.toggle,
 * experiments.get, experiments.getOne) and cache results locally.
 *
 * @module experiments/index
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DaemonExperimentRegistry = void 0;
/** All recognized session-toggleable experiment names. */
const AVAILABLE_EXPERIMENTS = [
    'page_diffing',
    'smart_waiting',
    'storage_inspection',
    'mouse_humanization',
    'fingerprinting',
];
const debugLog = (...args) => {
    const logger = global.DAEMON_LOGGER;
    if (logger)
        logger.log('[Experiments]', ...args);
};
/**
 * Per-session experiment state registry.
 *
 * Stores which experiments each MCP session has enabled. Sessions that haven't
 * explicitly toggled anything inherit from defaults injected at construction
 * time (from ConfigService, which merges file + env + CLI inputs).
 */
class DaemonExperimentRegistry {
    /** sessionId → Set of enabled experiment names */
    _sessions = new Map();
    /** Experiments pre-enabled by injected config snapshot. */
    _defaults = new Set();
    constructor(opts = {}) {
        if (opts.defaults) {
            for (const [name, enabled] of Object.entries(opts.defaults)) {
                if (enabled && this.isAvailable(name)) {
                    this._defaults.add(name);
                    debugLog(`Default enabled: ${name}`);
                }
            }
        }
    }
    /**
     * Apply experiment defaults. Retained for backwards compatibility with
     * call sites that supply a string list (e.g., tests). New code should
     * inject defaults via the constructor.
     */
    applyDefaults(experiments) {
        for (const exp of experiments) {
            if (this.isAvailable(exp)) {
                this._defaults.add(exp);
                debugLog(`Default enabled: ${exp}`);
            }
        }
    }
    /**
     * Toggle an experiment for a session.
     * Lazy-initializes the session's Set from defaults on first access.
     */
    toggle(sessionId, experiment, enabled) {
        if (!this.isAvailable(experiment)) {
            throw new Error(`Unknown experiment: "${experiment}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
        }
        let sessionSet = this._sessions.get(sessionId);
        if (!sessionSet) {
            sessionSet = new Set(this._defaults);
            this._sessions.set(sessionId, sessionSet);
        }
        if (enabled) {
            sessionSet.add(experiment);
        }
        else {
            sessionSet.delete(experiment);
        }
        debugLog(`${sessionId}: ${experiment} = ${enabled}`);
        return enabled;
    }
    /** Check if an experiment is enabled for a session. */
    isEnabled(sessionId, experiment) {
        const sessionSet = this._sessions.get(sessionId);
        if (sessionSet)
            return sessionSet.has(experiment);
        return this._defaults.has(experiment);
    }
    /** Get all experiment states for a session. */
    getAll(sessionId) {
        const states = {};
        for (const exp of AVAILABLE_EXPERIMENTS) {
            states[exp] = this.isEnabled(sessionId, exp);
        }
        return states;
    }
    /** Clean up a session's experiment state. */
    deleteSession(sessionId) {
        this._sessions.delete(sessionId);
        debugLog(`Session deleted: ${sessionId}`);
    }
    /** Initialize a session with defaults. No-op if already initialized. */
    initSession(sessionId) {
        if (!this._sessions.has(sessionId)) {
            this._sessions.set(sessionId, new Set(this._defaults));
        }
    }
    /** Check if an experiment name is recognized. */
    isAvailable(experiment) {
        return AVAILABLE_EXPERIMENTS.includes(experiment);
    }
    /** Return all recognized experiment names. */
    listAvailable() {
        return AVAILABLE_EXPERIMENTS;
    }
}
exports.DaemonExperimentRegistry = DaemonExperimentRegistry;
//# sourceMappingURL=index.js.map