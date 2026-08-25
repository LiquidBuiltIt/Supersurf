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
  // A map entry is only ever created together with its first name — never
  // empty — so no `names.length > 0` guard is needed here.
  return index.get(host) ?? null;
}

/**
 * Render the exact status-header hint line for a set of matched playbook
 * names. Caps the visible list at 5 names; beyond that, the count becomes
 * the literal string `5+` and the line ends with `+ more`.
 *
 * Expects `names` already sorted — `buildPlaybookDomainIndex` sorts once at
 * build time, and every production caller reads through
 * `matchPlaybookNamesForUrl`, which returns that same sorted list. Re-sorting
 * here would be dead work on every status-header render.
 */
export function formatPlaybookHintLine(names: string[]): string {
  if (names.length <= MAX_NAMES) {
    return `► ${names.length} playbooks available: ${names.join(', ')} | playbooks "list" for more details`;
  }
  const shown = names.slice(0, MAX_NAMES);
  return `► 5+ playbooks available: ${shown.join(', ')} + more | playbooks "list" for more details`;
}
