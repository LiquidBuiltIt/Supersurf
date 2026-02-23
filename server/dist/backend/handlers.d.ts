/**
 * Connection-level tool handlers — enable, disable, status, experimental features, reload.
 *
 * Each handler receives the ConnectionManagerAPI (mutable state), the tool arguments,
 * and an options object. Handlers return either MCP content responses (for MCP mode)
 * or raw JSON objects (for script mode via `rawResult: true`).
 *
 * State transitions managed here:
 *   - `onEnable`:  passive -> active (starts WebSocket, creates BrowserBridge)
 *   - `onDisable`: active/connected -> passive (tears down everything)
 *   - `onReloadMCP`: triggers exit code 42 for the debug wrapper to restart
 *
 * @module backend/handlers
 */
import type { ConnectionManagerAPI } from './types';
/**
 * Activate browser automation: validate client_id, start WebSocket server,
 * create BrowserBridge, apply pre-enabled experiments from env.
 * Transitions state from passive to active.
 */
export declare function onEnable(mgr: ConnectionManagerAPI, args?: Record<string, unknown>, options?: {
    rawResult?: boolean;
}): Promise<any>;
/**
 * Deactivate browser automation: tear down bridge, stop WebSocket, reset
 * experiments and mouse humanization, transition back to passive.
 */
export declare function onDisable(mgr: ConnectionManagerAPI, options?: {
    rawResult?: boolean;
}): Promise<any>;
/** Return current connection state, browser info, and attached tab details. */
export declare function onStatus(mgr: ConnectionManagerAPI, options?: {
    rawResult?: boolean;
}): Promise<any>;
/**
 * Toggle experimental features. With no recognized keys, lists current states.
 * For mouse_humanization, also initializes/destroys the humanization session
 * and notifies the extension.
 */
export declare function onExperimentalFeatures(mgr: ConnectionManagerAPI, args?: Record<string, unknown>, options?: {
    rawResult?: boolean;
}): Promise<any>;
/** Trigger hot reload by exiting with code 42. The debug wrapper catches this and respawns. */
export declare function onReloadMCP(mgr: ConnectionManagerAPI, options?: {
    rawResult?: boolean;
}): any;
//# sourceMappingURL=handlers.d.ts.map