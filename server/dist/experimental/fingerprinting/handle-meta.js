"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeHandleMeta = mergeHandleMeta;
// server/src/experimental/fingerprinting/handle-meta.ts
const naming_1 = require("./naming");
/**
 * Pure decision of canonical-vs-alias for an incoming (name, purpose) against an existing record.
 * - First-seen name becomes canonical.
 * - A differing normalized name is harvested as an alias (freq++), never overwriting canonical.
 * - purpose: latest non-empty value wins; empty preserves the prior.
 * Never throws.
 */
function mergeHandleMeta(existing, incoming) {
    const canonical = existing?.name;
    const aliases = { ...(existing?.aliases ?? {}) };
    // purpose: latest non-empty wins, else keep prior.
    const incomingPurpose = typeof incoming.purpose === 'string' ? incoming.purpose.trim() : '';
    const purpose = incomingPurpose || existing?.purpose;
    const norm = (0, naming_1.normalizeName)(incoming.name);
    const normalized = (0, naming_1.wasNormalized)(incoming.name);
    // No usable name — preserve identity, just carry purpose through.
    if (!norm) {
        return {
            name: canonical,
            purpose,
            aliases: existing?.aliases,
            outcome: 'none',
            normalized: false,
        };
    }
    // First name for this element — becomes canonical.
    if (!canonical) {
        return { name: norm, purpose, outcome: 'new', normalized };
    }
    // Same as canonical — nothing new.
    if (norm === canonical) {
        return { name: canonical, purpose, aliases: existing?.aliases, outcome: 'existing', normalized };
    }
    // Differing name — harvest as alias, never displace canonical.
    const freq = (aliases[norm] ?? 0) + 1;
    aliases[norm] = freq;
    return {
        name: canonical,
        purpose,
        aliases,
        outcome: 'alias',
        addedAlias: norm,
        aliasFreq: freq,
        normalized,
    };
}
//# sourceMappingURL=handle-meta.js.map