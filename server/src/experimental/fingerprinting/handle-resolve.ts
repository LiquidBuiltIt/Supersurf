// server/src/experimental/fingerprinting/handle-resolve.ts
//
// The read side of playbooks: translate an agent-supplied handle name
// (`tweet_button`) back into the selector of the element it was bound to at
// capture time. Pure + synchronous; the caller owns the experiment gate.

import { loadDomain } from './store';
import { normalizeName } from './naming';
import type { FingerprintRecord } from './types';

/**
 * A bare snake_case identifier with at least one underscore.
 *
 * The underscore is load-bearing, not cosmetic: `button`, `input`, `a` and
 * `summary` are all valid CSS tag selectors AND valid `normalizeName` output, so
 * accepting single words would make every tag selector ambiguous. Requiring an
 * underscore removes that entire collision class — and an underscore-joined bare
 * identifier is not a realistic tag selector either, since custom-element names
 * must contain a hyphen per the HTML spec.
 */
const HANDLE_RE = /^[a-z0-9]+(_[a-z0-9]+)+$/;

/** True when `s` is shaped like a handle name rather than a CSS selector. */
export function looksLikeHandle(s: string): boolean {
  return typeof s === 'string' && s.length <= 64 && HANDLE_RE.test(s);
}

/** A handle name matched to a stored record. */
export interface HandleResolution {
  /** The stored selector to actually query with. */
  selector: string;
  record: FingerprintRecord;
  /** Whether the name matched the record's canonical handle or one of its aliases. */
  match: 'canonical' | 'alias';
  /** How many records in this domain+route carried the name (canonical + alias). */
  candidateCount: number;
}

/** hits desc, then lastSeenAt desc — the record that has actually been working wins. */
function bestFirst(a: FingerprintRecord, b: FingerprintRecord): number {
  return (b.hits - a.hits) || (b.lastSeenAt - a.lastSeenAt);
}

/**
 * Look up a handle name in one domain store. Single file read (`loadDomain`),
 * never per-record `getRecord` — that re-reads and re-parses the whole domain
 * file on every call.
 *
 * Canonical matches beat alias matches; ties inside a tier break on hits then
 * recency. Multiple records legitimately carry the same name (the same element
 * captured under two selector keys), so this picks a best candidate rather than
 * rejecting the ambiguity.
 *
 * Scoped to the exact `route` — route templating is deferred to round two.
 */
export function resolveHandleName(
  domain: string,
  route: string,
  name: string,
): HandleResolution | null {
  const norm = normalizeName(name);
  if (!norm) return null;

  const byRoute = loadDomain(domain).routes[route];
  if (!byRoute) return null;

  const canonical: FingerprintRecord[] = [];
  const alias: FingerprintRecord[] = [];
  for (const rec of Object.values(byRoute)) {
    if (rec.handleName === norm) canonical.push(rec);
    else if (rec.aliases && rec.aliases[norm] !== undefined) alias.push(rec);
  }

  const candidateCount = canonical.length + alias.length;
  if (candidateCount === 0) return null;

  const tier = canonical.length > 0 ? canonical : alias;
  const match: HandleResolution['match'] = canonical.length > 0 ? 'canonical' : 'alias';
  const record = tier.sort(bestFirst)[0];

  return { selector: record.selector, record, match, candidateCount };
}
