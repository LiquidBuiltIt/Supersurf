"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeHandleMeta = mergeHandleMeta;
// server/src/experimental/fingerprinting/handle-meta.ts
const naming_1 = require("./naming");
const handle_resolve_1 = require("./handle-resolve");
/**
 * Pure decision of the canonical handle name for an incoming (name, purpose) against an
 * existing record.
 * - First-seen name becomes canonical.
 * - A differing normalized name is a NO-OP: canonical is sticky, and nothing about the
 *   differing name is persisted. It is reported once as `outcome: 'ignored'` so the
 *   naming-drift signal survives in the telemetry trail rather than in the corpus.
 * - purpose: latest non-empty value wins; empty preserves the prior.
 * Never throws.
 */
function mergeHandleMeta(existing, incoming) {
    const canonical = existing?.name;
    // purpose: latest non-empty wins, else keep prior.
    const incomingPurpose = typeof incoming.purpose === 'string' ? incoming.purpose.trim() : '';
    const purpose = incomingPurpose || existing?.purpose;
    const norm = (0, naming_1.normalizeName)(incoming.name);
    const normalized = (0, naming_1.wasNormalized)(incoming.name);
    // No usable name, or a name that doesn't have the mandatory underscore (e.g. a
    // bare "submit") — preserve identity, just carry purpose through. A shape that
    // fails `looksLikeHandle` can never be resolved back (see handle-resolve.ts), so
    // persisting it as canonical would produce a name resolution permanently rejects.
    if (!norm || !(0, handle_resolve_1.looksLikeHandle)(norm)) {
        return { name: canonical, purpose, outcome: 'none', normalized: false };
    }
    // First name for this element — becomes canonical.
    if (!canonical) {
        return { name: norm, purpose, outcome: 'new', normalized };
    }
    // Same as canonical — a plain re-hit.
    if (norm === canonical) {
        return { name: canonical, purpose, outcome: 'existing', normalized };
    }
    // Differing name — canonical wins and the new name is discarded.
    return { name: canonical, purpose, outcome: 'ignored', ignoredName: norm, normalized };
}
//# sourceMappingURL=handle-meta.js.map