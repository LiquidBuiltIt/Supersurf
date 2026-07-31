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
 * Every selector shape a record could plausibly be recognised by downstream.
 *
 * Exact-string keys only — no fuzzy matching. `browser_lookup` and the
 * `browser_snapshot` form-field collector both synthesise `tag#id` first and
 * `tag[name="..."]` second (see tools/content.ts), which is why those shapes are
 * indexed alongside the record's own stored selector.
 *
 * Class-based shapes (`tag.a.b`) are deliberately NOT indexed: framework-hashed
 * class names churn between deploys and the collectors truncate to the first two
 * classes in DOM order, so a class key would produce confident wrong answers. A
 * miss renders exactly as it does today, which is the correct failure mode.
 */
function keysFor(rec: FingerprintRecord): string[] {
  const keys: string[] = [rec.selector];
  const tag = rec.tag || '';
  if (rec.htmlId) {
    if (tag) keys.push(`${tag}#${rec.htmlId}`);
    keys.push(`#${rec.htmlId}`);
  }
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
    for (const rec of Object.values(byRoute)) {
      if (!rec.handleName) continue;
      for (const key of keysFor(rec)) {
        // First writer wins. A record's own stored selector is its strongest key and
        // is registered first, so an exact match is never displaced by a derived one.
        if (!index.has(key)) index.set(key, rec.handleName);
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
