"use strict";
// server/src/tools/interaction/option-matcher.ts
//
// Option-matching algorithm injected into the page via select_custom.
// Pure JS (no TS, no closures over server state) because it runs in the
// page's isolated world via Runtime.evaluate.
//
// Designed to recover from real-world ATS mismatches like:
//   target "United States" vs option "United States +1"
//   target "United States +1" vs option "United States+1" (no space)
//
// Returns the index of the best candidate, or -1 if no match.
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPTION_MATCHER_JS = void 0;
exports.OPTION_MATCHER_JS = `
function matchOption(target, candidates) {
  if (!target || !candidates || candidates.length === 0) return -1;
  var norm = function (s) { return (s || '').toLowerCase().replace(/\\s+/g, ' ').trim(); };
  var alnum = function (s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var t = norm(target);
  var ta = alnum(target);
  if (!t && !ta) return -1;
  var best = -1;
  var bestScore = 999;
  var bestLen = Infinity;
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i] || {};
    var text = norm(c.text);
    var value = norm(c.value);
    var textA = alnum(c.text);
    var valueA = alnum(c.value);
    var score = 999;
    if (t && (text === t || value === t)) score = 0;
    else if (ta && (textA === ta || valueA === ta)) score = 1;
    else if (t && (text.startsWith(t) || value.startsWith(t))) score = 2;
    else if (ta && (textA.startsWith(ta) || valueA.startsWith(ta))) score = 3;
    else if (t && (text.includes(t) || value.includes(t))) score = 4;
    else if (ta && (textA.includes(ta) || valueA.includes(ta))) score = 5;
    var len = (c.text || '').length;
    if (score < bestScore || (score === bestScore && len < bestLen)) {
      bestScore = score;
      best = i;
      bestLen = len;
    }
  }
  return bestScore < 999 ? best : -1;
}
`;
//# sourceMappingURL=option-matcher.js.map