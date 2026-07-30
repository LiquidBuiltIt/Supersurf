// server/src/experimental/fingerprinting/url.ts
//
// URL → storage-key helpers. A leaf module (no local imports) so both index.ts
// and handle-resolve.ts can use them without an import cycle.

export function domainOf(url: string | undefined): string {
  try {
    const u = new URL(url || '');
    // file:// pages have no hostname but are real, automatable pages — give them
    // a dedicated bucket (route = path) instead of collapsing into 'unknown'.
    if (u.protocol === 'file:') return 'file';
    return u.hostname.replace(/^www\./, '') || 'unknown';
  } catch { return 'unknown'; }
}

export function routeOf(url: string | undefined): string {
  try { return new URL(url || '').pathname || '/'; } catch { return '/'; }
}
