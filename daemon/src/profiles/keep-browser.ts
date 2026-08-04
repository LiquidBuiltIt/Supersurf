/**
 * Whether to skip SIGTERM on last MCP session disconnect.
 * - No pooled connection → true (do not kill; preference unknown).
 * - Otherwise → only when the extension explicitly opted in (`=== true`).
 */
export function shouldKeepBrowserOnSessionEnd(
  conn: { keepBrowserOnSessionEnd?: boolean } | null | undefined,
): boolean {
  if (conn == null) return true;
  return conn.keepBrowserOnSessionEnd === true;
}

export function applyKeepBrowserPreference(
  conn: { keepBrowserOnSessionEnd: boolean },
  value: unknown,
): void {
  if (typeof value === 'boolean') {
    conn.keepBrowserOnSessionEnd = value;
  }
  // non-boolean / missing: leave existing (already defaulted false on create)
}
