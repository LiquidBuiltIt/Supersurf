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
export declare const QUERY_DEEP_SOURCE = "function queryDeep(selector) {\n  var light = document.querySelector(selector);\n  if (light) return light;\n\n  var queue = [document];\n  while (queue.length) {\n    var root = queue.shift();\n    var els = root.querySelectorAll('*');\n    for (var i = 0; i < els.length; i++) {\n      var sr = els[i].shadowRoot;\n      if (!sr) continue;\n      var hit = sr.querySelector(selector);\n      if (hit) return hit;\n      queue.push(sr);\n    }\n  }\n  return null;\n}";
/**
 * Source for `function queryAllDeep(selector)` — every element matching
 * `selector` across the light tree and every open shadow root. Order: light
 * DOM matches first, then breadth-first by shadow depth. Deduplicated.
 */
export declare const QUERY_ALL_DEEP_SOURCE = "function queryAllDeep(selector) {\n  var out = [];\n  var seen = new Set();\n\n  var lightMatches = document.querySelectorAll(selector);\n  for (var i = 0; i < lightMatches.length; i++) {\n    if (!seen.has(lightMatches[i])) {\n      seen.add(lightMatches[i]);\n      out.push(lightMatches[i]);\n    }\n  }\n\n  var queue = [document];\n  while (queue.length) {\n    var root = queue.shift();\n    var els = root.querySelectorAll('*');\n    for (var j = 0; j < els.length; j++) {\n      var sr = els[j].shadowRoot;\n      if (!sr) continue;\n      var matches = sr.querySelectorAll(selector);\n      for (var k = 0; k < matches.length; k++) {\n        if (!seen.has(matches[k])) {\n          seen.add(matches[k]);\n          out.push(matches[k]);\n        }\n      }\n      queue.push(sr);\n    }\n  }\n  return out;\n}";
//# sourceMappingURL=shadow-walker.d.ts.map