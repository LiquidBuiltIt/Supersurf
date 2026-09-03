"use strict";
/**
 * Extension version compatibility check.
 *
 * The extension reports its manifest version in the WebSocket handshake
 * (extension/src/connection/websocket.ts). The daemon compares it against its
 * own package version and refuses connections it was not built for.
 *
 * Rule (owner decision 2026-09-01): reject on major OR minor mismatch, warn on
 * patch. Settled by evidence, not taste — 2.1.0 (a MINOR) removed
 * `capabilities.profiles` from the session_ack handshake, a breaking wire
 * change; 3.0.1 (a PATCH) added `config_drift`, purely additive.
 *
 * Deliberately NOT the exact-match rule used by the server<->daemon guard in
 * server/src/backend/handlers.ts. Those two npm packages are published in
 * lockstep so any difference is a stale process. A CWS-installed extension
 * auto-updates on Google's schedule and can legitimately lead or lag the npm
 * packages by days; exact-match would false-positive constantly.
 *
 * Fails OPEN on unparsable input: getVersion() in main.ts returns the literal
 * string 'unknown' when it cannot find its own package.json, and turning that
 * packaging edge case into a hard connection refusal would be worse than the
 * skew it guards against.
 *
 * @module profiles/extension-version
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareExtensionVersion = compareExtensionVersion;
exports.applyHandshakeVersion = applyHandshakeVersion;
/** Parse the leading `major.minor.patch` triple, ignoring any suffix. */
function parseTriple(version) {
    if (typeof version !== 'string')
        return null;
    const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m)
        return null;
    return {
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
    };
}
/**
 * Compare an extension's reported version against the daemon's own.
 *
 * @param daemonVersion - The daemon's package version (may be 'unknown').
 * @param extensionVersion - Whatever arrived in the handshake `version` field.
 */
function compareExtensionVersion(daemonVersion, extensionVersion) {
    const ext = parseTriple(extensionVersion);
    if (!ext) {
        const seen = typeof extensionVersion === 'string' && extensionVersion.trim()
            ? `reported "${extensionVersion}"`
            : 'did not report a version';
        return {
            status: 'warn',
            message: `The connected extension ${seen}, which this daemon (${daemonVersion}) cannot ` +
                'check. Allowing the connection. If browser commands behave oddly, update the ' +
                'extension at chrome://extensions.',
            guardActive: false,
        };
    }
    const own = parseTriple(daemonVersion);
    if (!own) {
        return {
            status: 'warn',
            message: `This daemon could not determine its own version (got "${daemonVersion}"), so the ` +
                `extension version (${extensionVersion}) was not checked. Allowing the connection.`,
            guardActive: false,
        };
    }
    if (own.major !== ext.major || own.minor !== ext.minor) {
        return {
            status: 'rejected',
            message: `Extension version ${extensionVersion} is not compatible with SuperSurf ` +
                `${daemonVersion}. Major and minor versions must match; only patch releases may ` +
                'differ. Update the extension at chrome://extensions (or wait for the Chrome Web ' +
                'Store auto-update), or install the matching package with ' +
                '`npx supersurf-mcp@latest mcp`.',
            guardActive: true,
        };
    }
    if (own.patch !== ext.patch) {
        return {
            status: 'warn',
            message: `Extension version ${extensionVersion} differs from SuperSurf ${daemonVersion} at ` +
                'the patch level. Patch releases are additive, so the connection is allowed.',
            guardActive: true,
        };
    }
    return { status: 'ok', message: null, guardActive: true };
}
/**
 * Apply a handshake's version field to a pooled connection.
 *
 * Mirrors the applyKeepBrowserPreference precedent in ./keep-browser.ts — a
 * pure-ish mutator over a connection-shaped object, so the reject path is
 * testable without a live WebSocket server.
 *
 * On rejection this deliberately does three things in order: mark the
 * connection unusable, fail any agent already waiting on this slot with the
 * named error, and only then close the socket. Closing first would remove the
 * connection from the pool while the waiter still sat in the pending queue.
 */
function applyHandshakeVersion(conn, message, daemonVersion, matchmaker) {
    const verdict = compareExtensionVersion(daemonVersion, message.version);
    conn.version = typeof message.version === 'string' ? message.version : null;
    conn.versionStatus = verdict.status;
    conn.versionError = verdict.message;
    // The handshake's own profile field is more current than the cookie-derived
    // one already on the connection, and the bridge has not applied it yet.
    const slot = typeof message.profile === 'string' && message.profile
        ? message.profile
        : conn.profile;
    if (verdict.status === 'rejected') {
        matchmaker.recordVersionRejection({
            profile: slot,
            version: conn.version,
            message: verdict.message,
        });
        matchmaker.failPendingMatches(slot, new Error(verdict.message));
        conn.ws.close(4001, 'extension version mismatch');
        return verdict;
    }
    matchmaker.clearVersionRejection(slot);
    return verdict;
}
//# sourceMappingURL=extension-version.js.map