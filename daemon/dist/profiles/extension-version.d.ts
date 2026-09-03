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
/** Lifecycle of a pooled connection's version check. */
export type ExtensionVersionStatus = 'pending' | 'ok' | 'warn' | 'rejected';
/** Outcome of comparing an extension version against the daemon's own. */
export interface VersionVerdict {
    status: 'ok' | 'warn' | 'rejected';
    /** User-facing explanation. Null only when status is 'ok'. */
    message: string | null;
    /**
     * False when neither version could be parsed and the check was therefore
     * skipped. The caller escalates an inactive guard to stderr — a guard that
     * is silently off reads as a passing check, which is worse than no guard.
     */
    guardActive: boolean;
}
/**
 * Compare an extension's reported version against the daemon's own.
 *
 * @param daemonVersion - The daemon's package version (may be 'unknown').
 * @param extensionVersion - Whatever arrived in the handshake `version` field.
 */
export declare function compareExtensionVersion(daemonVersion: string, extensionVersion: unknown): VersionVerdict;
/** The Matchmaker surface `applyHandshakeVersion` needs. Narrowed for testability. */
export interface VersionAwareMatchmaker {
    failPendingMatches(profile: string | null, error: Error): number;
    recordVersionRejection(rejection: {
        profile: string | null;
        version: string | null;
        message: string;
    }): void;
    clearVersionRejection(profile: string | null): void;
}
/** The subset of a pooled connection this module mutates. */
interface VersionedConn {
    ws: {
        close(code?: number, reason?: string): void;
    };
    profile: string | null;
    version: string | null;
    versionStatus: ExtensionVersionStatus;
    versionError: string | null;
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
export declare function applyHandshakeVersion(conn: VersionedConn, message: {
    version?: unknown;
    profile?: unknown;
}, daemonVersion: string, matchmaker: VersionAwareMatchmaker): VersionVerdict;
export {};
//# sourceMappingURL=extension-version.d.ts.map