/**
 * Connection-level tool handlers — connect, disconnect, status, experimental features, reload.
 *
 * Each handler receives the ConnectionManagerAPI (mutable state), the tool arguments,
 * and an options object. Handlers return either MCP content responses (for MCP mode)
 * or raw JSON objects (for script mode via `rawResult: true`).
 *
 * State transitions managed here:
 *   - `onConnect`:  passive -> active (spawns daemon, connects via DaemonClient, creates BrowserBridge)
 *   - `onDisconnect`: active/connected -> passive (closes daemon session)
 *   - `onReloadMCP`: triggers exit code 42 for the debug wrapper to restart
 *
 * @module backend/handlers
 */
import type { ConnectionManagerAPI } from './types';
/**
 * Connect to the SuperSurf daemon: validate client_id, spawn daemon if needed,
 * connect via DaemonClient, create BrowserBridge, apply pre-enabled experiments.
 * Transitions state from passive to active.
 */
export declare function onConnect(mgr: ConnectionManagerAPI, args?: Record<string, unknown>, options?: {
    rawResult?: boolean;
}): Promise<any>;
/**
 * Apply a `tab_info_update` notification to the attached-tab snapshot.
 *
 * A null update clears the tab. A non-null update rebuilds the snapshot **even when
 * `attachedTab` was previously null** — the prior version skipped the update unless a
 * tab was already attached, which left the URL stale/empty after a reconnect (reconnect
 * nulls the tab) and mis-filed fingerprint captures into the 'unknown' bucket. Exported
 * for testing.
 */
export declare function applyTabInfoUpdate(mgr: ConnectionManagerAPI, tabInfo: any): void;
/** Minimal daemon-client surface needed to re-query tabs. */
interface TabQueryClient {
    sendCmd: (method: string, params: Record<string, unknown>, timeout?: number) => Promise<unknown>;
}
/**
 * After a reconnect, re-query the extension for the attached tab and repopulate
 * `mgr.attachedTab` (URL included). Without this, the tab stays null until the next
 * navigation fires a `tab_info_update`, so any fingerprint capture in between has no
 * live URL and gets dropped. Best-effort: any failure falls back to null. Exported for testing.
 */
export declare function rehydrateAttachedTab(mgr: ConnectionManagerAPI, client: TabQueryClient): Promise<void>;
/**
 * Disconnect from the daemon: tear down bridge, close DaemonClient session,
 * reset experiments and mouse humanization, transition back to passive.
 * The daemon stays alive for other sessions.
 */
export declare function onDisconnect(mgr: ConnectionManagerAPI, options?: {
    rawResult?: boolean;
}): Promise<any>;
/** Return current connection state, browser info, and attached tab details. */
export declare function onStatus(mgr: ConnectionManagerAPI, options?: {
    rawResult?: boolean;
}): Promise<any>;
/** Create a new managed Chromium profile. */
export declare function onProfileCreate(mgr: ConnectionManagerAPI, args?: Record<string, unknown>, options?: {
    rawResult?: boolean;
}): Promise<any>;
/** List all managed Chromium profiles. */
export declare function onProfileList(mgr: ConnectionManagerAPI, options?: {
    rawResult?: boolean;
}): Promise<any>;
/** Delete a managed Chromium profile. */
export declare function onProfileDelete(mgr: ConnectionManagerAPI, args?: Record<string, unknown>, options?: {
    rawResult?: boolean;
}): Promise<any>;
/** Trigger hot reload by exiting with code 42. The debug wrapper catches this and respawns. */
export declare function onReloadMCP(mgr: ConnectionManagerAPI, options?: {
    rawResult?: boolean;
}): any;
export {};
//# sourceMappingURL=handlers.d.ts.map