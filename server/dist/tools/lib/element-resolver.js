"use strict";
// server/src/tools/element-resolver.ts
//
// Selector → element resolution. Stateless functions consumed by the
// ToolContext factory. Takes an `evalFn` callback rather than an
// IExtensionTransport so callers can inject a pre-bound evaluator.
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSelectorExpression = getSelectorExpression;
exports.findAlternativeSelectors = findAlternativeSelectors;
exports.getElementCenter = getElementCenter;
/**
 * Rewrite digit-leading IDs (`#883a76-...`) to `[id="..."]` form.
 * CSS spec disallows ID identifiers that start with a digit, so
 * `document.querySelector('#883a76')` throws `SyntaxError: not a valid selector`
 * — but Ashby (and other apps that use UUID-style element IDs) emit them anyway.
 * The attribute-selector form is always valid, so we transparently rewrite.
 */
function rewriteDigitLeadingIds(selector) {
    return selector.replace(/(^|[\s>+~,])([a-zA-Z][\w-]*)?#(\d[\w-]*)/g, (_, lead, tag, id) => `${lead}${tag || ''}[id="${id}"]`);
}
/**
 * Convert a CSS selector (with optional `:has-text("...")`) into a JS
 * expression that resolves to the matching Element or null. The
 * `:has-text` form is a SuperSurf extension — the page-eval falls back
 * to scanning textContent when the selector includes it.
 */
function getSelectorExpression(selector) {
    if (!selector)
        throw new Error('Selector is required for this action');
    const rewritten = rewriteDigitLeadingIds(selector);
    const m = rewritten.match(/^(.+?):has-text\(["'](.+?)["']\)(.*)$/);
    if (m) {
        const [, base, text] = m;
        return `(() => {
      for (const el of document.querySelectorAll(${JSON.stringify(base)})) {
        if (el.textContent && el.textContent.includes(${JSON.stringify(text)})) return el;
      }
      return null;
    })()`;
    }
    return `document.querySelector(${JSON.stringify(rewritten)})`;
}
/**
 * Search the page for elements whose direct text content includes the
 * `:has-text(...)` substring of the failing selector. Returns up to
 * three visible candidates and two hidden, each with a guess at a
 * usable selector. Returns `[]` when the input doesn't have a
 * `:has-text(...)` suffix or when the page-eval throws.
 */
async function findAlternativeSelectors(evalFn, selector) {
    const m = selector.match(/:has-text\(["'](.+?)["']\)/);
    if (!m)
        return [];
    const searchText = m[1];
    try {
        const result = await evalFn(`
      (() => {
        const searchText = ${JSON.stringify(searchText)};
        const searchLower = searchText.trim().toLowerCase();
        const alts = [];

        for (const el of document.querySelectorAll('*')) {
          let directText = '';
          for (const n of el.childNodes) {
            if (n.nodeType === Node.TEXT_NODE) directText += n.textContent;
          }
          directText = directText.trim();
          if (!directText.toLowerCase().includes(searchLower)) continue;

          let sel = el.tagName.toLowerCase();
          if (el.id) {
            sel += '#' + el.id;
          } else if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\\\\s+/).filter(Boolean);
            if (cls.length > 0) sel += '.' + cls.slice(0, 2).join('.');
          } else if (el.getAttribute('role')) {
            sel += '[role="' + el.getAttribute('role') + '"]';
          }

          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
                          style.opacity !== '0' && rect.width > 0 && rect.height > 0;

          alts.push({
            selector: sel,
            visible,
            text: directText.length > 50 ? directText.substring(0, 50) + '...' : directText,
          });
        }

        const vis = alts.filter(a => a.visible);
        const hid = alts.filter(a => !a.visible);
        return [...vis.slice(0, 3), ...hid.slice(0, 2)];
      })()
    `);
        return result || [];
    }
    catch {
        return [];
    }
}
/**
 * Resolve a selector to its element's viewport-center coordinates.
 * On miss, throws an Error whose message includes "Did you mean?"
 * suggestions when the selector contains `:has-text(...)`.
 */
async function getElementCenter(evalFn, selector) {
    const expr = getSelectorExpression(selector);
    const result = await evalFn(`
    (() => {
      const el = ${expr};
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    })()
  `);
    if (!result) {
        const hints = await findAlternativeSelectors(evalFn, selector);
        let msg = `Element not found: \`${selector}\``;
        if (hints && hints.length > 0) {
            msg += '\n\nDid you mean?';
            hints.forEach((alt, i) => {
                const vis = alt.visible ? '' : ' (hidden)';
                msg += `\n  ${i + 1}. \`${alt.selector}\`${vis}`;
                if (alt.text)
                    msg += `\n     Text: "${alt.text}"`;
            });
        }
        throw new Error(msg);
    }
    return result;
}
//# sourceMappingURL=element-resolver.js.map