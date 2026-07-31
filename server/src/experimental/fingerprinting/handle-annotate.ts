// server/src/experimental/fingerprinting/handle-annotate.ts
//
// Reader-side handle substitution. Given the URL of the attached tab, build a
// one-shot index from the selector shapes `browser_snapshot` and `browser_lookup`
// synthesise in-page back to the canonical handle name recorded for that element.
//
// ONE `loadDomain` per index build, never one per node. The readers call
// `buildHandleIndex` exactly once per tool call and then probe the returned Map;
// a 200-node snapshot must never turn into 200 store reads.

import { loadDomain } from './store';
import { domainOf, routeOf } from './url';
import { experimentRegistry } from '../index';
import type { FingerprintRecord } from './types';

/** Selector shape -> canonical handle name. */
export type HandleIndex = Map<string, string>;

/**
 * Derived selector shapes a record could plausibly be recognised by downstream —
 * everything EXCEPT the record's own stored selector (that one is registered
 * separately, in its own pass; see `buildHandleIndex`).
 *
 * Exact-string keys only — no fuzzy matching. `browser_lookup` and the
 * `browser_snapshot` form-field collector both synthesise `tag#id` first and
 * `tag[name="..."]` second (see tools/content.ts:88-96 and :196-201), which is why
 * those two shapes are derived here. Neither collector ever emits a bare `#id` —
 * both always prepend the tag name first — so a bare `#id` key is not derived; a
 * record whose own stored selector genuinely is `#foo` is already covered by the
 * own-selector pass.
 *
 * Class-based shapes (`tag.a.b`) are deliberately NOT indexed: framework-hashed
 * class names churn between deploys and the collectors truncate to the first two
 * classes in DOM order, so a class key would produce confident wrong answers. A
 * miss renders exactly as it does today, which is the correct failure mode.
 */
function derivedKeysFor(rec: FingerprintRecord): string[] {
  const keys: string[] = [];
  const tag = rec.tag || '';
  if (tag && rec.htmlId) keys.push(`${tag}#${rec.htmlId}`);
  const nameAttr = rec.attrs?.name;
  if (tag && nameAttr) keys.push(`${tag}[name="${nameAttr}"]`);
  return keys;
}

/**
 * Build the handle index for the page at `url`.
 *
 * Returns an empty index when the `fingerprinting` experiment is off, the URL has
 * no usable domain, or nothing was ever recorded on this exact route — callers then
 * render exactly as they did before. Never throws.
 */
export function buildHandleIndex(url: string | undefined): HandleIndex {
  const index: HandleIndex = new Map();
  if (!experimentRegistry.isEnabled('fingerprinting')) return index;

  const domain = domainOf(url);
  // Nothing is ever persisted into the 'unknown' bucket (see captureOnResolve).
  if (domain === 'unknown') return index;

  try {
    const byRoute = loadDomain(domain).routes[routeOf(url)];
    if (!byRoute) return index;
    const named = Object.values(byRoute).filter((rec) => rec.handleName);

    // Two passes so a record's OWN stored selector always wins its exact-match slot,
    // even when another record's DERIVED key would otherwise land on that same string
    // first. Two records can legitimately describe the same element under different
    // selector keys (see handle-resolve.ts:53-54) — without this ordering, record A's
    // derived `tag#foo` could occupy the slot before record B's own stored selector of
    // `tag#foo` is ever tried, permanently binding the wrong handle name to it.
    for (const rec of named) {
      // First writer wins among stored selectors too, in case two records were ever
      // stored under the identical selector string (should not happen, but cheap to keep safe).
      if (!index.has(rec.selector)) index.set(rec.selector, rec.handleName!);
    }
    for (const rec of named) {
      for (const key of derivedKeysFor(rec)) {
        if (!index.has(key)) index.set(key, rec.handleName!);
      }
    }
  } catch {
    return index; // annotation is cosmetic; never break a read tool
  }
  return index;
}

/**
 * Render a selector for agent-facing output, substituting the recorded handle when
 * there is one. An unrecorded selector comes back byte-identical.
 *
 * FORMAT NOTE: `name [selector]` — handle first, the CSS kept alongside it so the
 * agent always retains a working fallback. This shape is a deliberately cheap swap:
 * if it ever costs us accuracy, change the template on the line below (and its test).
 * Nothing downstream parses this string.
 */
export function annotateSelector(index: HandleIndex, selector: string): string {
  if (index.size === 0) return selector;
  const name = index.get(selector);
  return name ? `${name} [${selector}]` : selector;
}
