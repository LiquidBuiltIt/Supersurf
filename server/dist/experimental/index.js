"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.experimentRegistry = exports.formatDiffSection = exports.calculateConfidence = exports.diffSnapshots = void 0;
exports.applyInitialState = applyInitialState;
exports.getExperimentalToolSchemas = getExperimentalToolSchemas;
exports.callExperimentalTool = callExperimentalTool;
var page_diffing_1 = require("./page-diffing");
Object.defineProperty(exports, "diffSnapshots", { enumerable: true, get: function () { return page_diffing_1.diffSnapshots; } });
Object.defineProperty(exports, "calculateConfidence", { enumerable: true, get: function () { return page_diffing_1.calculateConfidence; } });
Object.defineProperty(exports, "formatDiffSection", { enumerable: true, get: function () { return page_diffing_1.formatDiffSection; } });
const storage_inspection_1 = require("./storage-inspection");
/** All recognized session-toggleable experiment names. */
const AVAILABLE_EXPERIMENTS = ['page_diffing', 'smart_waiting', 'storage_inspection', 'mouse_humanization'];
/**
 * Cache-backed IPC proxy for experiment state.
 *
 * Reads are synchronous (from local cache). Writes IPC to the daemon and
 * update the cache on success. The ~20 isEnabled() call sites in tools/
 * remain unchanged — same sync signature, same behavior.
 */
class ExperimentRegistry {
    _cache = new Map();
    _transport = null;
    /** Bind to a daemon transport. Called on connect. */
    bind(transport) {
        this._transport = transport;
    }
    /** Unbind transport and clear cache. Called on disconnect. */
    unbind() {
        this._transport = null;
        this._cache.clear();
    }
    /**
     * Toggle an experiment. IPCs to daemon, then updates local cache.
     * Reserved for programmatic use; v2 disables session-level toggling
     * via MCP (experiments come from `~/.supersurf/config.json`).
     */
    async toggle(feature, enabled) {
        if (!this.isAvailable(feature)) {
            throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
        }
        if (this._transport && this._transport.connected) {
            await this._transport.sendCmd('experiments.toggle', { experiment: feature, enabled }, 5000);
        }
        this._cache.set(feature, enabled);
    }
    /**
     * Enable an experiment. Fire-and-forget IPC for backwards compat with applyInitialState.
     * Throws if the name is not in AVAILABLE_EXPERIMENTS.
     */
    enable(feature) {
        if (!this.isAvailable(feature)) {
            throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
        }
        if (this._transport && this._transport.connected) {
            this._transport.sendCmd('experiments.toggle', { experiment: feature, enabled: true }, 5000).catch(() => { });
        }
        this._cache.set(feature, true);
    }
    /**
     * Disable an experiment. Fire-and-forget IPC for backwards compat.
     * Throws if the name is not in AVAILABLE_EXPERIMENTS.
     */
    disable(feature) {
        if (!this.isAvailable(feature)) {
            throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
        }
        if (this._transport && this._transport.connected) {
            this._transport.sendCmd('experiments.toggle', { experiment: feature, enabled: false }, 5000).catch(() => { });
        }
        this._cache.set(feature, false);
    }
    /** Returns true only if the experiment is enabled in the local cache. Sync — no IPC. */
    isEnabled(feature) {
        return this._cache.get(feature) === true;
    }
    /** Clear local cache. Daemon handles session cleanup on disconnect. */
    reset() {
        this._cache.clear();
    }
    /** Return a copy of all recognized experiment names. */
    listAvailable() {
        return [...AVAILABLE_EXPERIMENTS];
    }
    /** Return a snapshot of all experiments and their current cached state. */
    getStates() {
        const states = {};
        for (const exp of AVAILABLE_EXPERIMENTS) {
            states[exp] = this.isEnabled(exp);
        }
        return states;
    }
    /** Check if a feature name is recognized (exists in AVAILABLE_EXPERIMENTS). */
    isAvailable(feature) {
        return AVAILABLE_EXPERIMENTS.includes(feature);
    }
}
exports.experimentRegistry = new ExperimentRegistry();
/**
 * Pre-enable session features from a Config experiments snapshot.
 * Silently skips feature names that aren't in AVAILABLE_EXPERIMENTS
 * (notably `profiles`, which is a daemon-startup flag, not session-toggleable).
 * Fire-and-forget IPCs to daemon for each enabled experiment.
 */
function applyInitialState(experiments) {
    for (const [name, enabled] of Object.entries(experiments)) {
        if (enabled && exports.experimentRegistry.isAvailable(name)) {
            exports.experimentRegistry.enable(name);
        }
    }
}
// ─── Experimental tool dispatch ───────────────────────────────
/** Collect schemas from all experimental tool modules */
function getExperimentalToolSchemas() {
    return [storage_inspection_1.storageInspectionSchema];
}
/**
 * Try to dispatch a tool call to an experimental handler.
 * Returns the result if handled, or null if the tool name isn't experimental.
 */
async function callExperimentalTool(name, ctx, args, options) {
    switch (name) {
        case 'browser_storage':
            return await (0, storage_inspection_1.onBrowserStorage)(ctx, args, options);
        default:
            return null;
    }
}
//# sourceMappingURL=index.js.map