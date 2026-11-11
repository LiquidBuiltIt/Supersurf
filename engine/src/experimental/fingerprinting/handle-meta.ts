// server/src/experimental/fingerprinting/handle-meta.ts
import { normalizeName, wasNormalized } from './naming';
import { looksLikeHandle } from './handle-resolve';

export interface HandleMeta {
  name?: string;
  purpose?: string;
}

export interface MergeResult {
  name?: string;
  purpose?: string;
  outcome: 'new' | 'existing' | 'ignored' | 'none';
  /** The differing name that was NOT stored. Telemetry only — never persisted. */
  ignoredName?: string;
  normalized: boolean; // did the incoming name require normalization?
}

type ExistingHandle = { name?: string; purpose?: string } | undefined;

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
export function mergeHandleMeta(existing: ExistingHandle, incoming: HandleMeta): MergeResult {
  const canonical = existing?.name;

  // purpose: latest non-empty wins, else keep prior.
  const incomingPurpose = typeof incoming.purpose === 'string' ? incoming.purpose.trim() : '';
  const purpose = incomingPurpose || existing?.purpose;

  const norm = normalizeName(incoming.name);
  const normalized = wasNormalized(incoming.name);

  // No usable name, or a name that doesn't have the mandatory underscore (e.g. a
  // bare "submit") — preserve identity, just carry purpose through. A shape that
  // fails `looksLikeHandle` can never be resolved back (see handle-resolve.ts), so
  // persisting it as canonical would produce a name resolution permanently rejects.
  if (!norm || !looksLikeHandle(norm)) {
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
