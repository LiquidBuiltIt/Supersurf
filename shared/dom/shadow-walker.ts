/**
 * Shadow-DOM-piercing element queries — page-context source, not Node code.
 *
 * `server/src/tools/lib/element-resolver.ts` builds a plain
 * `document.querySelector(...)` expression that gets injected into the page
 * via CDP `Runtime.evaluate`. That's blind to elements nested inside open
 * shadow roots. These two functions fix that: light DOM is tried first,
 * shadow roots are only walked on a miss (non-breaking — a selector that
 * resolves today keeps resolving to the same element).
 *
 * Exported as raw source STRINGS, not TS functions, for two reasons:
 *   1. This code runs in the page, not in Node — it references `document`,
 *      which isn't in `shared`'s ES2022/Node lib and would fail typecheck
 *      as a real TS declaration.
 *   2. Both injection paths need literal source text: server-side CDP
 *      `Runtime.evaluate` interpolates it into a template-string expression;
 *      extension-side `chrome.scripting.executeScript({ func })` serializes
 *      via `Function.prototype.toString()`. A string constant already IS
 *      that text — no stringify step, no risk of it drifting from what
 *      actually runs.
 *
 * SELF-CONTAINMENT IS LOAD-BEARING: `executeScript({ func })` serializes
 * exactly one function and drops everything else in scope — no imports, no
 * closures, no references to sibling top-level functions. The two sources
 * below duplicate their traversal logic rather than sharing a helper on
 * purpose. Do not factor that out.
 *
 * @module shared/dom/shadow-walker
 */

/**
 * Source for `function queryDeep(selector)` — first element matching
 * `selector`, piercing open shadow roots. Tries `document.querySelector`
 * first; only walks shadow roots (BFS) on a miss. Returns `null` on no
 * match anywhere, never throws.
 */
export const QUERY_DEEP_SOURCE = `function queryDeep(selector) {
  var light = document.querySelector(selector);
  if (light) return light;

  var queue = [document];
  while (queue.length) {
    var root = queue.shift();
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var sr = els[i].shadowRoot;
      if (!sr) continue;
      var hit = sr.querySelector(selector);
      if (hit) return hit;
      queue.push(sr);
    }
  }
  return null;
}`;

/**
 * Source for `function queryAllDeep(selector)` — every element matching
 * `selector` across the light tree and every open shadow root. Order: light
 * DOM matches first, then breadth-first by shadow depth. Deduplicated.
 */
export const QUERY_ALL_DEEP_SOURCE = `function queryAllDeep(selector) {
  var out = [];
  var seen = new Set();

  var lightMatches = document.querySelectorAll(selector);
  for (var i = 0; i < lightMatches.length; i++) {
    if (!seen.has(lightMatches[i])) {
      seen.add(lightMatches[i]);
      out.push(lightMatches[i]);
    }
  }

  var queue = [document];
  while (queue.length) {
    var root = queue.shift();
    var els = root.querySelectorAll('*');
    for (var j = 0; j < els.length; j++) {
      var sr = els[j].shadowRoot;
      if (!sr) continue;
      var matches = sr.querySelectorAll(selector);
      for (var k = 0; k < matches.length; k++) {
        if (!seen.has(matches[k])) {
          seen.add(matches[k]);
          out.push(matches[k]);
        }
      }
      queue.push(sr);
    }
  }
  return out;
}`;
