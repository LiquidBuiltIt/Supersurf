"use strict";
// server/src/experimental/fingerprinting/naming.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeName = normalizeName;
exports.wasNormalized = wasNormalized;
/** Normalize an agent-supplied handle name to snake_case. Never throws.
 *  Returns '' for nullish/empty/punctuation-only input (caller treats '' as "no name"). */
function normalizeName(raw) {
    if (typeof raw !== 'string')
        return '';
    const s = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_') // any run of non-alphanumerics -> single _
        .replace(/^_+|_+$/g, ''); // strip leading/trailing _
    return s.slice(0, 64).replace(/^_+|_+$/g, ''); // re-strip: truncation can reintroduce a trailing _
}
/** True when normalizeName(raw) differs from the trimmed input (i.e. it wasn't already canonical). */
function wasNormalized(raw) {
    if (typeof raw !== 'string')
        return false;
    const trimmed = raw.trim();
    if (trimmed === '')
        return false;
    return normalizeName(raw) !== trimmed;
}
//# sourceMappingURL=naming.js.map