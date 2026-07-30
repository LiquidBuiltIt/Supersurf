/** Session-end kill is skipped unless the extension explicitly opts out (false). */
export function shouldKeepBrowserOnSessionEnd(
  conn: { keepBrowserOnSessionEnd?: boolean } | null | undefined,
): boolean {
  return conn?.keepBrowserOnSessionEnd !== false;
}

export function applyKeepBrowserPreference(
  conn: { keepBrowserOnSessionEnd: boolean },
  value: unknown,
): void {
  if (typeof value === 'boolean') {
    conn.keepBrowserOnSessionEnd = value;
  }
  // non-boolean / missing: leave existing (already defaulted true on create)
}
