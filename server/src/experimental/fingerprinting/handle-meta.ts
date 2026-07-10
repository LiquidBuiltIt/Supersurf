// server/src/experimental/fingerprinting/handle-meta.ts
import { normalizeName, wasNormalized } from './naming';

export interface HandleMeta {
  name?: string;
  purpose?: string;
}

export interface MergeResult {
  name?: string;
  purpose?: string;
  aliases?: Record<string, number>;
  outcome: 'new' | 'alias' | 'existing' | 'none';
  addedAlias?: string;
  aliasFreq?: number;
  normalized: boolean; // did the incoming name require normalization?
}

type ExistingHandle = { name?: string; purpose?: string; aliases?: Record<string, number> } | undefined;

/**
 * Pure decision of canonical-vs-alias for an incoming (name, purpose) against an existing record.
 * - First-seen name becomes canonical.
 * - A differing normalized name is harvested as an alias (freq++), never overwriting canonical.
 * - purpose: latest non-empty value wins; empty preserves the prior.
 * Never throws.
 */
export function mergeHandleMeta(existing: ExistingHandle, incoming: HandleMeta): MergeResult {
  const canonical = existing?.name;
  const aliases: Record<string, number> = { ...(existing?.aliases ?? {}) };

  // purpose: latest non-empty wins, else keep prior.
  const incomingPurpose = typeof incoming.purpose === 'string' ? incoming.purpose.trim() : '';
  const purpose = incomingPurpose || existing?.purpose;

  const norm = normalizeName(incoming.name);
  const normalized = wasNormalized(incoming.name);

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
