/**
 * Interaction tool handlers — click, type, scroll, hover, etc.
 *
 * Handles the `browser_interact` tool which accepts an ordered array of
 * actions and executes them sequentially. Integrates with two experimental
 * features: page_diffing (captures DOM before/after and returns a diff)
 * and mouse_humanization (generates Bezier-curve mouse paths).
 *
 * All mouse interactions go through CDP `Input.dispatch*` events with
 * realistic timing based on the Balabit Mouse Dynamics dataset.
 *
 * @module tools/interaction
 */
import type { ToolContext } from './types';
/**
 * Pure-JS option matcher used by `select_custom`.
 *
 * Inlined into the page-context eval AND independently unit-tested via
 * `new Function(OPTION_MATCHER_JS + '...')`. Both call sites share the same
 * source string so behavior cannot drift.
 *
 * Match strategy (lowest score = best match):
 *   0 — exact normalized match (whitespace-collapsed, case-insensitive)
 *   1 — alphanumeric-only equality (ignores all spaces/punctuation)
 *   2 — candidate text/value startsWith target
 *   3 — alphanumeric-only startsWith
 *   4 — candidate includes target as substring
 *   5 — alphanumeric-only substring
 *
 * Tie-breaker at the same score: shortest candidate text wins (most specific).
 *
 * Designed to recover from real-world ATS mismatches like
 *   target "United States" vs option "United States +1"
 *   target "United States +1" vs option "United States+1" (no space)
 *
 * Returns the index of the best candidate, or -1 if no match.
 */
export declare const OPTION_MATCHER_JS = "\nfunction matchOption(target, candidates) {\n  if (!target || !candidates || candidates.length === 0) return -1;\n  var norm = function (s) { return (s || '').toLowerCase().replace(/\\s+/g, ' ').trim(); };\n  var alnum = function (s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };\n  var t = norm(target);\n  var ta = alnum(target);\n  if (!t && !ta) return -1;\n  var best = -1;\n  var bestScore = 999;\n  var bestLen = Infinity;\n  for (var i = 0; i < candidates.length; i++) {\n    var c = candidates[i] || {};\n    var text = norm(c.text);\n    var value = norm(c.value);\n    var textA = alnum(c.text);\n    var valueA = alnum(c.value);\n    var score = 999;\n    if (t && (text === t || value === t)) score = 0;\n    else if (ta && (textA === ta || valueA === ta)) score = 1;\n    else if (t && (text.startsWith(t) || value.startsWith(t))) score = 2;\n    else if (ta && (textA.startsWith(ta) || valueA.startsWith(ta))) score = 3;\n    else if (t && (text.includes(t) || value.includes(t))) score = 4;\n    else if (ta && (textA.includes(ta) || valueA.includes(ta))) score = 5;\n    var len = (c.text || '').length;\n    if (score < bestScore || (score === bestScore && len < bestLen)) {\n      bestScore = score;\n      best = i;\n      bestLen = len;\n    }\n  }\n  return bestScore < 999 ? best : -1;\n}\n";
/**
 * Execute a sequence of page interactions (click, type, hover, scroll, etc.).
 *
 * Optionally captures DOM state before/after for page diffing, and returns
 * per-action success/failure results. The `onError` arg controls whether
 * the sequence stops on first failure or continues.
 *
 * @param ctx - Tool context with CDP/eval/extension access
 * @param args - `{ actions: Action[], onError?: 'stop'|'ignore', screenshot?: boolean }`
 * @param options - `{ rawResult?: boolean }`
 */
export declare function onInteract(ctx: ToolContext, args: any, options: any): Promise<any>;
//# sourceMappingURL=interaction.d.ts.map