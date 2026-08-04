"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldKeepBrowserOnSessionEnd = shouldKeepBrowserOnSessionEnd;
exports.applyKeepBrowserPreference = applyKeepBrowserPreference;
/**
 * Whether to skip SIGTERM on last MCP session disconnect.
 * - No pooled connection → true (do not kill; preference unknown).
 * - Otherwise → only when the extension explicitly opted in (`=== true`).
 */
function shouldKeepBrowserOnSessionEnd(conn) {
    if (conn == null)
        return true;
    return conn.keepBrowserOnSessionEnd === true;
}
function applyKeepBrowserPreference(conn, value) {
    if (typeof value === 'boolean') {
        conn.keepBrowserOnSessionEnd = value;
    }
    // non-boolean / missing: leave existing (already defaulted false on create)
}
//# sourceMappingURL=keep-browser.js.map