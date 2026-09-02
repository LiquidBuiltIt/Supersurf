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

/** Parse the leading `major.minor.patch` triple, ignoring any suffix. */
function parseTriple(version: unknown): { major: number; minor: number; patch: number } | null {
  if (typeof version !== 'string') return null;
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
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
export function compareExtensionVersion(
  daemonVersion: string,
  extensionVersion: unknown,
): VersionVerdict {
  const ext = parseTriple(extensionVersion);
  if (!ext) {
    const seen = typeof extensionVersion === 'string' && extensionVersion.trim()
      ? `reported "${extensionVersion}"`
      : 'did not report a version';
    return {
      status: 'warn',
      message:
        `The connected extension ${seen}, which this daemon (${daemonVersion}) cannot ` +
        'check. Allowing the connection. If browser commands behave oddly, update the ' +
        'extension at chrome://extensions.',
      guardActive: false,
    };
  }

  const own = parseTriple(daemonVersion);
  if (!own) {
    return {
      status: 'warn',
      message:
        `This daemon could not determine its own version (got "${daemonVersion}"), so the ` +
        `extension version (${extensionVersion}) was not checked. Allowing the connection.`,
      guardActive: false,
    };
  }

  if (own.major !== ext.major || own.minor !== ext.minor) {
    return {
      status: 'rejected',
      message:
        `Extension version ${extensionVersion} is not compatible with SuperSurf ` +
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
      message:
        `Extension version ${extensionVersion} differs from SuperSurf ${daemonVersion} at ` +
        'the patch level. Patch releases are additive, so the connection is allowed.',
      guardActive: true,
    };
  }

  return { status: 'ok', message: null, guardActive: true };
}
