/**
 * Status-header discovery hint — surfaces playbooks that match the
 * currently attached tab's domain. Pure helpers; the mutable cache and
 * once-per-session suppression live on `ConnectionManager` (see `backend.ts`).
 *
 * @module playbooks/hint
 */

import { listPlaybooks } from './store';
import { derivePlaybookDomains, normalizeHost } from './domains';

const MAX_NAMES = 5;

/** domain -> sorted, deduped playbook names that match it. */
export type PlaybookDomainIndex = Map<string, string[]>;

/** Scan every saved playbook once and index it by derived domain. */
export function buildPlaybookDomainIndex(): PlaybookDomainIndex {
  const index: PlaybookDomainIndex = new Map();
  for (const pb of listPlaybooks()) {
    for (const domain of derivePlaybookDomains(pb.steps)) {
      const names = index.get(domain);
      if (names) names.push(pb.name);
      else index.set(domain, [pb.name]);
    }
  }
  for (const names of index.values()) names.sort((a, b) => a.localeCompare(b));
  return index;
}

/**
 * Look up the playbook names matching a tab URL's normalized host.
 * Returns `null` when the URL has no matchable host or there is no match —
 * callers should not render a hint in either case.
 */
export function matchPlaybookNamesForUrl(index: PlaybookDomainIndex, url: string | undefined | null): string[] | null {
  const host = normalizeHost(url);
  if (!host) return null;
  const names = index.get(host);
  return names && names.length > 0 ? names : null;
}

/**
 * Render the exact status-header hint line for a set of matched playbook
 * names. Caps the visible list at 5 names; beyond that, the count becomes
 * the literal string `5+` and the line ends with `+ more`.
 */
export function formatPlaybookHintLine(names: string[]): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (sorted.length <= MAX_NAMES) {
    return `► ${sorted.length} playbooks available: ${sorted.join(', ')} | playbooks "list" for more details`;
  }
  const shown = sorted.slice(0, MAX_NAMES);
  return `► 5+ playbooks available: ${shown.join(', ')} + more | playbooks "list" for more details`;
}
