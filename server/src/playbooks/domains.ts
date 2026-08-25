/**
 * Domain derivation for playbooks — no manifest field, computed at read time
 * from each step's recorded `url` so existing playbooks work retroactively.
 *
 * Normalization is shared by both sides of a match (a playbook's derived
 * domains, and the tab URL / CLI-supplied filter being matched against them):
 * lowercase, strip a leading `www.`. No suffix walking — an exact match on
 * the normalized host only.
 *
 * @module playbooks/domains
 */

import type { PlaybookStep } from './types';

function stripWww(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

/**
 * Extract and normalize the hostname from a URL. Returns `null` for a
 * missing/malformed URL or a non-http(s) scheme (e.g. `chrome://`, `about:`,
 * `file://`) — those never contribute a matchable domain.
 */
export function normalizeHost(rawUrl: string | undefined | null): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = stripWww(u.hostname);
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Normalize a bare domain string (not a full URL) the same way, for the
 * `playbooks {action:"list", domain:"..."}` filter param.
 */
export function normalizeDomain(raw: string): string {
  return stripWww(raw.trim());
}

/**
 * Deduped, alphabetically sorted, normalized hostnames of every step's
 * recorded `url`. Steps with no `url` or a non-http(s) `url` are ignored.
 */
export function derivePlaybookDomains(steps: PlaybookStep[]): string[] {
  const set = new Set<string>();
  for (const step of steps) {
    const host = normalizeHost(step.url);
    if (host) set.add(host);
  }
  return Array.from(set).sort();
}
