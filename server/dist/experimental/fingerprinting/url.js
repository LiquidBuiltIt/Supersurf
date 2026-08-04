"use strict";
// server/src/experimental/fingerprinting/url.ts
//
// URL → storage-key helpers. A leaf module (no local imports) so both index.ts
// and handle-resolve.ts can use them without an import cycle.
Object.defineProperty(exports, "__esModule", { value: true });
exports.domainOf = domainOf;
exports.routeOf = routeOf;
function domainOf(url) {
    try {
        const u = new URL(url || '');
        // file:// pages have no hostname but are real, automatable pages — give them
        // a dedicated bucket (route = path) instead of collapsing into 'unknown'.
        if (u.protocol === 'file:')
            return 'file';
        return u.hostname.replace(/^www\./, '') || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
function routeOf(url) {
    try {
        return new URL(url || '').pathname || '/';
    }
    catch {
        return '/';
    }
}
//# sourceMappingURL=url.js.map