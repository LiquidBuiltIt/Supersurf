"use strict";
// server/src/tools/lib/selector-qualify.ts
//
// Round-trip selector qualification — page-context source, not Node code.
//
// A displayed candidate selector used to be built for READABILITY and then
// bound as if it were an IDENTITY. On a page of class-less anchors
// (news.ycombinator.com) every candidate described itself as `a`, three
// ephemeral handles bound to the string `a`, and all three resolved to the
// first `<a>` in the document. The click reported success.
//
// The fix is a contract, not a heuristic: a selector may only be printed or
// bound once it has been shown to resolve BACK to the element it describes,
// using the same resolver semantics the runtime will use. When no rung of the
// ladder verifies, the honest answer is "no handle" — see rung 5.
//
// Exported as a raw source STRING for the same reason as
// `shared/dom/shadow-walker.ts`: this code runs in the page, not in Node. It
// references `document` and `CSS`, which are not in the server's TS lib.
//
// ASSUMPTION A1 — candidates are always light-DOM. Both candidate expressions
// in `element-resolver.ts` enumerate with `document.querySelectorAll('*')`,
// which does not pierce shadow roots, so `document.querySelector` here has
// identical semantics to the runtime's `queryDeep` (which tries
// `document.querySelector` first). If candidates ever become shadow-aware,
// splice `QUERY_DEEP_SOURCE` in here or this check silently stops matching
// what the runtime does.
//
// @module tools/lib/selector-qualify
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUALIFY_SOURCE = void 0;
/**
 * Page-code source defining `qualify(el, base)` plus its helpers.
 *
 * `qualify` returns `{ selector, source }`:
 *   - `selector` — a selector that provably resolves back to `el`, or `base`
 *     unchanged when nothing verified.
 *   - `source` — `'unique'` | `'text'` | `'attr:<name>'` | `'path'`, or `null`
 *     when nothing verified. `null` is the caller's signal to mint NO handle.
 *
 * Callers must splice this in BEFORE any code that calls `qualify`.
 */
exports.QUALIFY_SOURCE = `
  /**
   * Resolve a selector exactly the way \`getSelectorExpression\` does:
   * \`:has-text("...")\` scans the base match set for the first element whose
   * SUBTREE textContent contains the phrase; anything else is a plain
   * querySelector. Never throws — an invalid selector yields null.
   */
  const ssResolve = (sel) => {
    try {
      const m = String(sel).match(/^(.+?):has-text\\(["'](.+?)["']\\)/);
      if (m) {
        const list = document.querySelectorAll(m[1]);
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (c.textContent && c.textContent.indexOf(m[2]) !== -1) return c;
        }
        return null;
      }
      return document.querySelector(sel);
    } catch (e) {
      return null;
    }
  };

  /**
   * Make a string safe to embed in \`:has-text("...")\` AND safe to store as a
   * resolve-time identity fact. Three traps, all load-bearing:
   *   1. NO ellipsis. The display text is capped at 50 chars with a literal
   *      '...' appended; a selector built from that can never match.
   *   2. NO quotes. The :has-text grammar stops at the first quote character
   *      and has no unescaping step, so a quote cannot be escaped in — only
   *      excluded. A backslash is excluded for the same reason.
   *   3. NO raw whitespace runs. Collapsed to single spaces.
   * Truncation to 50 is safe because :has-text matches with indexOf, so a
   * prefix still matches the full text.
   */
  const ssSafe = (t) => {
    const s = String(t == null ? '' : t).replace(/\\s+/g, ' ').trim();
    if (s.indexOf('"') !== -1 || s.indexOf("'") !== -1 || s.indexOf('\\\\') !== -1) return '';
    return s.slice(0, 50);
  };

  /** An element's own direct text — text nodes only, no descendants. */
  const ssOwnText = (el) => {
    let t = '';
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 3) t += kids[i].textContent;
    }
    return ssSafe(t);
  };

  /**
   * Direct texts of descendants, breadth-first, to \`maxDepth\` levels below
   * \`el\` (depth 1 = direct children). Capped at 8 strings: a text-dense
   * container must not blow the per-candidate budget. Depth 3 is the default
   * the caller passes — see the plan's rung-2 rationale.
   */
  const ssDescendantTexts = (el, maxDepth) => {
    const out = [];
    let level = el.children ? Array.prototype.slice.call(el.children) : [];
    for (let d = 1; d <= maxDepth && level.length && out.length < 8; d++) {
      const next = [];
      for (let i = 0; i < level.length && out.length < 8; i++) {
        const c = level[i];
        const t = ssOwnText(c);
        if (t.length >= 3 && out.indexOf(t) === -1) out.push(t);
        if (c.children) {
          for (let j = 0; j < c.children.length; j++) next.push(c.children[j]);
        }
      }
      level = next;
    }
    return out;
  };

  /** Attributes that can distinguish two otherwise-identical elements, in
   *  descending order of how meaningful they are to a human reader. */
  const SS_ATTRS = ['aria-label', 'data-testid', 'name', 'title', 'placeholder', 'alt', 'href', 'type'];

  /**
   * Positional chain, anchored on the first id-bearing ancestor or on <body>.
   * Anchoring is what makes it worth trying: an unanchored relative chain
   * matches the first such pair anywhere in the document, which is precisely
   * the failure mode this module exists to stop. It is still round-tripped
   * before it is accepted.
   */
  const ssPath = (el) => {
    const parts = [];
    let cur = el;
    for (let i = 0; i < 8 && cur && cur.nodeType === 1; i++) {
      if (cur === document.body) { parts.unshift('body'); return parts.join(' > '); }
      let n = 1, sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) n++; sib = sib.previousElementSibling; }
      parts.unshift(cur.tagName.toLowerCase() + ':nth-of-type(' + n + ')');
      if (i > 0 && cur.id) {
        parts[0] = cur.tagName.toLowerCase() + '#' + CSS.escape(cur.id);
        return parts.join(' > ');
      }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  /**
   * Climb the ladder until a selector resolves back to \`el\`. Returns
   * \`{ selector, source }\`; \`source === null\` means NOTHING verified and the
   * caller must mint no handle and print \`base\` alone.
   */
  const qualify = (el, base) => {
    if (ssResolve(base) === el) return { selector: base, source: 'unique' };

    const own = ssOwnText(el);
    if (own.length >= 1) {
      const s = base + ':has-text("' + own + '")';
      if (ssResolve(s) === el) return { selector: s, source: 'text' };
    }

    const desc = ssDescendantTexts(el, 3);
    for (let i = 0; i < desc.length; i++) {
      const s = base + ':has-text("' + desc[i] + '")';
      if (ssResolve(s) === el) return { selector: s, source: 'text' };
    }

    for (let i = 0; i < SS_ATTRS.length; i++) {
      const a = SS_ATTRS[i];
      const v = el.getAttribute ? el.getAttribute(a) : null;
      if (!v || v.length > 100) continue;
      if (v.indexOf('"') !== -1 || v.indexOf("\\\\") !== -1 || v.indexOf('\\n') !== -1) continue;
      const s = base + '[' + a + '="' + v + '"]';
      if (ssResolve(s) === el) return { selector: s, source: 'attr:' + a };
    }

    const p = ssPath(el);
    if (p && ssResolve(p) === el) return { selector: p, source: 'path' };

    return { selector: base, source: null };
  };
`;
//# sourceMappingURL=selector-qualify.js.map