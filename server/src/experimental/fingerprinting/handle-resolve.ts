// server/src/experimental/fingerprinting/handle-resolve.ts
//
// The read side of playbooks: translate an agent-supplied handle reference
// (`@tweet_button`) back into the selector of the element it was bound to at
// capture time. A selector-slot string is a handle reference only when it
// carries the leading `@` marker — no shape guessing. Pure + synchronous;
// `resolveSelectorOrHandle` checks the `fingerprinting` experiment gate itself,
// so callers don't have to.

import { loadDomain } from './store';
import { normalizeName } from './naming';
import { domainOf, routeOf } from './url';
import { experimentRegistry } from '../index';
import type { FingerprintRecord } from './types';

/**
 * A bare snake_case identifier with at least one underscore — the shape a
 * normalized handle name takes (see `naming.ts`).
 *
 * NOT used to decide whether a selector-slot string is a handle reference —
 * that is `isHandleRef`'s job, on the explicit `@` marker, with zero shape
 * inspection. This regex survives in two other roles: (a) capture-time
 * validation that a stored `handleName` is a shape `resolveHandleName` could
 * ever match again (`handle-meta.ts`, `handle-annotate.ts`), and (b) a
 * failure-path diagnostic (`handleMissHint` below) — never a resolution rule.
 */
const HANDLE_RE = /^[a-z0-9]+(_[a-z0-9]+)+$/;

/** True when `s` is shaped like a handle name. Resolution-time callers must use
 *  `isHandleRef` instead; this is for name-shape validation and diagnostics only. */
export function looksLikeHandle(s: string): boolean {
  return typeof s === 'string' && s.length <= 64 && HANDLE_RE.test(s);
}

/** The marker that declares a selector-slot string a handle reference. */
const HANDLE_MARKER = '@';

/**
 * True when a selector-slot string explicitly declares itself a handle reference
 * via the leading `@` marker — the ONLY test `resolveSelectorOrHandle` uses to
 * decide whether to attempt translation. No shape inspection, no ambiguity: a bare
 * `submit_review` is always a CSS selector; `@submit_review` is always a handle.
 */
export function isHandleRef(s: string): boolean {
  return typeof s === 'string' && s.startsWith(HANDLE_MARKER) && s.length > HANDLE_MARKER.length;
}

/**
 * Failure-path advisory for a selector that missed AND is shaped exactly like a
 * normalized handle name — the old resolution regex, demoted to a diagnostic only.
 * Returns '' when the shape gives no reason to suspect a forgotten `@` marker, so
 * callers can unconditionally splice the result into a "not found" message.
 */
export function handleMissHint(selector: string): string {
  if (!looksLikeHandle(selector)) return '';
  return `\n\nIf you meant the handle, target it with \`@${selector}\`.`;
}

/** A handle name matched to a stored record. */
export interface HandleResolution {
  /** The stored selector to actually query with. */
  selector: string;
  record: FingerprintRecord;
  /** How many records in this domain+route carried the name. */
  candidateCount: number;
}

/** hits desc, then lastSeenAt desc — the record that has actually been working wins. */
function bestFirst(a: FingerprintRecord, b: FingerprintRecord): number {
  return (b.hits - a.hits) || (b.lastSeenAt - a.lastSeenAt);
}

/**
 * Look up a handle name in one domain store. Single file read (`loadDomain`),
 * never per-record `getRecord`.
 *
 * A name matches only a record's canonical `handleName` — there is no second tier.
 * The first name an element is given is permanently sticky, so a loosely reused name
 * has no path to bind to an element it was never the canonical name for.
 *
 * Multiple records legitimately carry the same name (the same element captured under
 * two selector keys), so ties break on hits then recency rather than rejecting.
 *
 * Scoped to the exact `route` — route templating is deferred.
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

  const candidates: FingerprintRecord[] = [];
  for (const rec of Object.values(byRoute)) {
    if (rec.handleName === norm) candidates.push(rec);
  }
  if (candidates.length === 0) return null;

  const record = candidates.sort(bestFirst)[0];
  return { selector: record.selector, record, candidateCount: candidates.length };
}

/** What a translation attempt produced. */
export interface SelectorOrHandle {
  /** The selector to query with — the translated one on a hit, the input otherwise. */
  selector: string;
  /** Non-null only when a handle name matched a stored record. */
  handle: HandleResolution | null;
  /** True when the input looked like a handle and a lookup actually ran, so a
   *  `null` handle means "miss", not "this was a plain selector". */
  attempted: boolean;
}

/**
 * The single entry point for handle translation. Idempotent: a plain CSS
 * selector (or an already-translated one, which never carries the `@` marker)
 * costs one `startsWith` check and comes back unchanged, so every existing call
 * path is untouched.
 *
 * A miss deliberately returns the (marker-stripped) input rather than throwing —
 * the caller then runs the normal CSS path, which either finds a real element
 * with that name (unlikely, but harmless) or produces the normal not-found
 * error. There is no path on which a handle can resolve to the wrong element.
 *
 * The `@` marker is recognized — and stripped — before the experiment gate below,
 * not after: leaving it in place on a disabled/unknown-domain fallthrough would
 * hand the CSS path a syntactically invalid selector (`@foo`) instead of a clean
 * (if pointless) query for `foo`.
 */
export function resolveSelectorOrHandle(
  url: string | undefined,
  selector: string,
): SelectorOrHandle {
  if (!isHandleRef(selector)) {
    return { selector, handle: null, attempted: false };
  }
  const name = selector.slice(HANDLE_MARKER.length);

  if (!experimentRegistry.isEnabled('fingerprinting')) {
    return { selector: name, handle: null, attempted: false };
  }

  const domain = domainOf(url);
  // Nothing is ever persisted into the 'unknown' bucket (see captureOnResolve),
  // so there is nothing to resolve against.
  if (domain === 'unknown') return { selector: name, handle: null, attempted: false };

  const handle = resolveHandleName(domain, routeOf(url), name);
  if (!handle) return { selector: name, handle: null, attempted: true };
  return { selector: handle.selector, handle, attempted: true };
}
