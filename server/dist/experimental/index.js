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
/** All recognized session-toggleable experiment names. */
const AVAILABLE_EXPERIMENTS = ['page_diffing', 'smart_waiting', 'mouse_humanization', 'fingerprinting'];
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
class ExperimentRegistry {
    _sessions = new Map();
    /** Get-or-create the slot for a session id. */
    _slot(sessionId) {
        let slot = this._sessions.get(sessionId);
        if (!slot) {
            slot = { transport: null, cache: new Map() };
            this._sessions.set(sessionId, slot);
        }
        return slot;
    }
    /** Guard a feature name against AVAILABLE_EXPERIMENTS. */
    _assertAvailable(feature) {
        if (!this.isAvailable(feature)) {
            throw new Error(`Unknown experiment: "${feature}". Available: ${AVAILABLE_EXPERIMENTS.join(', ')}`);
        }
    }
    /** Fire-and-forget IPC + local cache write for one session. */
    _set(sessionId, feature, enabled) {
        this._assertAvailable(feature);
        const slot = this._slot(sessionId);
        if (slot.transport && slot.transport.connected) {
            slot.transport
                .sendCmd('experiments.toggle', { experiment: feature, enabled }, 5000)
                .catch(() => { });
        }
        slot.cache.set(feature, enabled);
    }
    /** Bind a session to its daemon transport. Called on connect. */
    bind(sessionId, transport) {
        this._slot(sessionId).transport = transport;
    }
    /** Drop a session's transport and cached flags. Called on disconnect. */
    unbind(sessionId) {
        this._sessions.delete(sessionId);
    }
    /**
     * Toggle an experiment for one session. IPCs to the daemon over that
     * session's transport, then updates its local cache. Reserved for
     * programmatic use; v2 disables session-level toggling via MCP
     * (experiments come from `~/.supersurf/config.json`).
     */
    async toggle(sessionId, feature, enabled) {
        this._assertAvailable(feature);
        const slot = this._slot(sessionId);
        if (slot.transport && slot.transport.connected) {
            await slot.transport.sendCmd('experiments.toggle', { experiment: feature, enabled }, 5000);
        }
        slot.cache.set(feature, enabled);
    }
    /**
     * Enable an experiment for one session. Fire-and-forget IPC.
     * Throws if the name is not in AVAILABLE_EXPERIMENTS.
     */
    enable(sessionId, feature) {
        this._set(sessionId, feature, true);
    }
    /**
     * Disable an experiment for one session. Fire-and-forget IPC.
     * Throws if the name is not in AVAILABLE_EXPERIMENTS.
     */
    disable(sessionId, feature) {
        this._set(sessionId, feature, false);
    }
    /**
     * Returns true only if the experiment is enabled in the cache. Sync — no IPC.
     * With `sessionId`, reads that session alone. Without it, returns true when
     * any bound session has the flag on.
     */
    isEnabled(feature, sessionId) {
        if (sessionId !== undefined) {
            return this._sessions.get(sessionId)?.cache.get(feature) === true;
        }
        for (const slot of this._sessions.values()) {
            if (slot.cache.get(feature) === true)
                return true;
        }
        return false;
    }
    /** Clear every session slot. Test hook and process-wide reset. */
    reset() {
        this._sessions.clear();
    }
    /** Return a copy of all recognized experiment names. */
    listAvailable() {
        return [...AVAILABLE_EXPERIMENTS];
    }
    /** Snapshot of all experiments for one session, or the union across sessions. */
    getStates(sessionId) {
        const states = {};
        for (const exp of AVAILABLE_EXPERIMENTS) {
            states[exp] = this.isEnabled(exp, sessionId);
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
 * Pre-enable one session's features from a Config experiments snapshot.
 * Silently skips feature names that aren't in AVAILABLE_EXPERIMENTS
 * (notably `profiles`, which is a daemon-startup flag, not session-toggleable).
 * Fire-and-forget IPCs to the daemon for each enabled experiment.
 */
function applyInitialState(sessionId, experiments) {
    for (const [name, enabled] of Object.entries(experiments)) {
        if (enabled && exports.experimentRegistry.isAvailable(name)) {
            exports.experimentRegistry.enable(sessionId, name);
        }
    }
}
// ─── Experimental tool dispatch ───────────────────────────────
/** Collect schemas from all experimental tool modules */
function getExperimentalToolSchemas() {
    return [];
}
/**
 * Try to dispatch a tool call to an experimental handler.
 * Returns the result if handled, or null if the tool name isn't experimental.
 */
async function callExperimentalTool(name, ctx, args, options) {
    switch (name) {
        default:
            return null;
    }
}
//# sourceMappingURL=index.js.map