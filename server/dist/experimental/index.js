"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.experimentRegistry = exports.wrapWithPageProxy = exports.analyzeCode = exports.formatDiffSection = exports.calculateConfidence = exports.diffSnapshots = void 0;
exports.isInfraExperimentEnabled = isInfraExperimentEnabled;
exports.applyInitialState = applyInitialState;
exports.getExperimentalToolSchemas = getExperimentalToolSchemas;
exports.callExperimentalTool = callExperimentalTool;
var page_diffing_1 = require("./page-diffing");
Object.defineProperty(exports, "diffSnapshots", { enumerable: true, get: function () { return page_diffing_1.diffSnapshots; } });
Object.defineProperty(exports, "calculateConfidence", { enumerable: true, get: function () { return page_diffing_1.calculateConfidence; } });
Object.defineProperty(exports, "formatDiffSection", { enumerable: true, get: function () { return page_diffing_1.formatDiffSection; } });
var secure_eval_1 = require("./secure-eval");
Object.defineProperty(exports, "analyzeCode", { enumerable: true, get: function () { return secure_eval_1.analyzeCode; } });
Object.defineProperty(exports, "wrapWithPageProxy", { enumerable: true, get: function () { return secure_eval_1.wrapWithPageProxy; } });
const storage_inspection_1 = require("./storage-inspection");
/** All recognized session-toggleable experiment names. */
const AVAILABLE_EXPERIMENTS = ['page_diffing', 'smart_waiting', 'storage_inspection', 'mouse_humanization', 'secure_eval'];
/**
 * Session-scoped feature flag registry.
 *
 * Tracks which experiments are currently enabled. Validation ensures only
 * recognized experiment names can be toggled — unknown names throw immediately
 * to surface typos at the call site.
 */
class ExperimentRegistry {
    _enabled = new Map();
    /** Enable an experiment. Throws if the name is not in AVAILABLE_EXPERIMENTS. */
    enable(feature) {
        if (!this.isAvailable(feature)) {
            throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
        }
        this._enabled.set(feature, true);
    }
    /** Disable an experiment. Throws if the name is not in AVAILABLE_EXPERIMENTS. */
    disable(feature) {
        if (!this.isAvailable(feature)) {
            throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
        }
        this._enabled.set(feature, false);
    }
    /** Returns true only if the experiment has been explicitly enabled. */
    isEnabled(feature) {
        return this._enabled.get(feature) === true;
    }
    /** Clear all experiment states (used in tests and session teardown). */
    reset() {
        this._enabled.clear();
    }
    /** Return a copy of all recognized experiment names. */
    listAvailable() {
        return [...AVAILABLE_EXPERIMENTS];
    }
    /** Return a snapshot of all experiments and their current enabled/disabled state. */
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
 * Check if an infrastructure-level experiment (e.g. "multiplexer") is enabled via env var.
 * Infrastructure experiments are gated at startup, not session-toggleable.
 */
function isInfraExperimentEnabled(feature, config) {
    if (!config.enabledExperiments)
        return false;
    return config.enabledExperiments.includes(feature);
}
/**
 * Pre-enable session features listed in the env var config.
 * Silently skips infra features (like "multiplexer") that aren't in AVAILABLE_EXPERIMENTS.
 */
function applyInitialState(config) {
    if (!config.enabledExperiments)
        return;
    for (const feature of config.enabledExperiments) {
        if (exports.experimentRegistry.isAvailable(feature)) {
            exports.experimentRegistry.enable(feature);
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