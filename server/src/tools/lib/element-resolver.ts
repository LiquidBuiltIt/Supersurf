// server/src/tools/element-resolver.ts
//
// Selector → element resolution. Stateless functions consumed by the
// ToolContext factory. Takes an `evalFn` callback rather than an
// IExtensionTransport so callers can inject a pre-bound evaluator.

import { QUERY_DEEP_SOURCE, QUERY_ALL_DEEP_SOURCE } from 'shared';
import { selectorTokens } from '../../playbooks/candidates';
import { mintHandleName, bindEphemeral } from '../../experimental/fingerprinting/ephemeral-handles';
import { QUALIFY_SOURCE } from './selector-qualify';

/** Async page evaluator signature (matches the inner closure of `evalExpr`). */
export type EvalFn = (expression: string, awaitPromise?: boolean) => Promise<any>;

/**
 * Rewrite digit-leading IDs (`#883a76-...`) to `[id="..."]` form.
 * CSS spec disallows ID identifiers that start with a digit, so
 * `document.querySelector('#883a76')` throws `SyntaxError: not a valid selector`
 * — but Ashby (and other apps that use UUID-style element IDs) emit them anyway.
 * The attribute-selector form is always valid, so we transparently rewrite.
 */
function rewriteDigitLeadingIds(selector: string): string {
  return selector.replace(
    /(^|[\s>+~,])([a-zA-Z][\w-]*)?#(\d[\w-]*)/g,
    (_, lead, tag, id) => `${lead}${tag || ''}[id="${id}"]`,
  );
}

/**
 * Convert a CSS selector (with optional `:has-text("...")`) into a JS
 * expression that resolves to the matching Element or null. The
 * `:has-text` form is a SuperSurf extension — the page-eval falls back
 * to scanning textContent when the selector includes it.
 *
 * Both branches pierce open shadow roots via `queryDeep`/`queryAllDeep`
 * (see `shared/dom/shadow-walker.ts`) — light DOM is tried first, shadow
 * roots are only walked on a miss, so a selector that resolves today keeps
 * resolving to the same element. Each returned expression is a self-contained
 * IIFE carrying its own copy of the walker function, since callers splice
 * the result directly into a larger expression (e.g. `const el = ${expr};`).
 */
export function getSelectorExpression(selector: string): string {
  if (!selector) throw new Error('Selector is required for this action');
  const rewritten = rewriteDigitLeadingIds(selector);
  const m = rewritten.match(/^(.+?):has-text\(["'](.+?)["']\)(.*)$/);
  if (m) {
    const [, base, text] = m;
    return `(() => {
      ${QUERY_ALL_DEEP_SOURCE}
      for (const el of queryAllDeep(${JSON.stringify(base)})) {
        if (el.textContent && el.textContent.includes(${JSON.stringify(text)})) return el;
      }
      return null;
    })()`;
  }
  return `(() => {
      ${QUERY_DEEP_SOURCE}
      return queryDeep(${JSON.stringify(rewritten)});
    })()`;
}

/**
 * The plural of `getSelectorExpression`: a JS expression resolving to an ARRAY
 * of every matching Element, empty when nothing matches.
 *
 * `browser_extract_content` in selector mode used the singular form and so read
 * only the first match — `.WorkflowJob` on a GitHub Actions run page matches
 * many jobs and reported `total: 1`. Callers that genuinely want one element
 * keep using `getSelectorExpression`; this is for the ones that should never
 * have been narrowed.
 *
 * Same two branches, same shadow-piercing walker, same digit-leading-id
 * rewrite — the ONLY difference is that `:has-text(...)` filters the full match
 * set instead of returning on the first hit.
 */
export function getAllSelectorExpression(selector: string): string {
  if (!selector) throw new Error('Selector is required for this action');
  const rewritten = rewriteDigitLeadingIds(selector);
  const m = rewritten.match(/^(.+?):has-text\(["'](.+?)["']\)(.*)$/);
  if (m) {
    const [, base, text] = m;
    return `(() => {
      ${QUERY_ALL_DEEP_SOURCE}
      return queryAllDeep(${JSON.stringify(base)}).filter(
        (el) => el.textContent && el.textContent.includes(${JSON.stringify(text)}),
      );
    })()`;
  }
  return `(() => {
      ${QUERY_ALL_DEEP_SOURCE}
      return queryAllDeep(${JSON.stringify(rewritten)});
    })()`;
}

/** One "Did you mean?" suggestion, after server-side ranking. */
export interface AltCandidate {
  /** A valid CSS selector the agent can paste straight back. */
  selector: string;
  visible: boolean;
  /** Direct text content, trimmed and capped. */
  text?: string;
  /** First non-empty accessible-name source: aria-label, title, placeholder, value, alt. */
  label?: string;
  tag: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Token-overlap score; 0 for text-matched and interactive-fallback candidates. */
  score: number;
  /** Ephemeral handle name, minted in Task 4. Absent when no confident text source exists. */
  handle?: string;
  /**
   * The ellipsis-free, quote-free, whitespace-collapsed prefix of the element's
   * direct text. `text` above is the DISPLAY form and carries a literal '...'
   * when truncated, which can never match anything. This is the form that goes
   * into a selector and into the binding's identity fact.
   */
  matchText: string;
  /** Same treatment for the accessible-name label. */
  matchLabel: string;
  /**
   * False when NO rung of the qualification ladder produced a selector that
   * resolves back to this element. A false here means: print `selector` alone,
   * mint no handle. See `selector-qualify.ts`.
   */
  qualified: boolean;
}

/** How many raw candidates the page is allowed to return before ranking. */
const RAW_CANDIDATE_CAP = 24;
/** How many survive into the rendered hint. */
const RENDERED_CAP = 5;
/** Hidden candidates shown only when the visible list is this thin. */
const VISIBLE_FLOOR = 3;
const HIDDEN_CAP = 2;

/**
 * The shared tail of every candidate page expression: describe one element.
 * Emits a VALID CSS selector — `#id` when there is one, else up to two
 * dot-joined classes, else a `[role=...]` attribute selector.
 *
 * Identifiers go through `CSS.escape`. Splitting the class attribute correctly
 * is only half of "valid CSS": a Tailwind utility (`md:flex`, `w-1/2`) or a
 * numeric-leading id is a legal class/id token but an ILLEGAL bare CSS
 * identifier, so `querySelector` throws `SyntaxError` on the unescaped form.
 * `CSS.escape` is a DOM API — this expression already calls `document`,
 * `window.getComputedStyle` and `getBoundingClientRect`, so it only ever runs
 * where `CSS.escape` exists (Chrome 41+). No fallback needed.
 *
 * Exported so tests can execute it directly rather than regex-scraping it out
 * of the larger expression. It depends on `QUALIFY_SOURCE` being spliced in
 * first — every emitter below does that.
 */
export const DESCRIBE_SOURCE = `
  const describe = (el, score) => {
    const esc = (s) => CSS.escape(String(s));
    let sel = el.tagName.toLowerCase();
    if (el.id) {
      sel += '#' + esc(el.id);
    } else if (el.className && typeof el.className === 'string' && el.className.trim()) {
      const cls = el.className.trim().split(/\\s+/).filter(Boolean);
      if (cls.length > 0) sel += '.' + cls.slice(0, 2).map(esc).join('.');
    } else if (el.getAttribute('role')) {
      sel += '[role="' + el.getAttribute('role') + '"]';
    }
    let directText = '';
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) directText += n.textContent;
    }
    directText = directText.trim().replace(/\\s+/g, ' ');
    const label = el.getAttribute('aria-label') || el.getAttribute('title')
      || el.getAttribute('placeholder') || (typeof el.value === 'string' ? el.value : '')
      || el.getAttribute('alt') || '';
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const qualified = qualify(el, sel);
    return {
      selector: qualified.selector,
      qualified: qualified.source !== null,
      tag: el.tagName.toLowerCase(),
      visible: style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && rect.width > 0 && rect.height > 0,
      text: directText.length > 50 ? directText.slice(0, 50) + '...' : directText,
      matchText: ssSafe(directText),
      label: String(label).replace(/\\s+/g, ' ').trim().slice(0, 50),
      matchLabel: ssSafe(label),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      score: score,
    };
  };
`;

/** Page expression for a `:has-text("...")` miss: elements whose DIRECT text contains the phrase. */
function textCandidateExpression(searchText: string): string {
  return `
    (() => {
      ${QUALIFY_SOURCE}
      ${DESCRIBE_SOURCE}
      const searchLower = ${JSON.stringify(searchText)}.trim().toLowerCase();
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        if (out.length >= ${RAW_CANDIDATE_CAP}) break;
        let directText = '';
        for (const n of el.childNodes) {
          if (n.nodeType === Node.TEXT_NODE) directText += n.textContent;
        }
        if (!directText.trim().toLowerCase().includes(searchLower)) continue;
        out.push(describe(el, 0));
      }
      return out;
    })()
  `;
}

/**
 * Page expression for a plain-CSS miss. Two passes, mirroring
 * `playbooks/candidates.ts`: loosened token match over id/class/data-testid/
 * aria-label first, then an interactive-element sweep to fill the remainder.
 * The interactive sweep always runs when the token pass under-fills, which is
 * the only useful answer for a selector like `tr.zA` whose tokens are all noise.
 */
function tokenCandidateExpression(tokens: string[]): string {
  return `
    (() => {
      ${QUALIFY_SOURCE}
      ${DESCRIBE_SOURCE}
      const tokens = ${JSON.stringify(tokens)};
      const limit = ${RAW_CANDIDATE_CAP};
      const out = [];
      const seen = new Set();
      if (tokens.length > 0) {
        const scored = [];
        for (const el of document.querySelectorAll('*')) {
          const hay = (el.id + ' '
            + (typeof el.className === 'string' ? el.className : '') + ' '
            + (el.getAttribute('data-testid') || '') + ' '
            + (el.getAttribute('aria-label') || '')).toLowerCase();
          if (!hay.trim()) continue;
          let score = 0;
          for (const t of tokens) if (hay.indexOf(t) !== -1) score++;
          if (score > 0) scored.push({ score: score, el: el });
        }
        scored.sort((a, b) => b.score - a.score);
        for (const s of scored.slice(0, limit)) {
          if (seen.has(s.el)) continue;
          seen.add(s.el);
          out.push(describe(s.el, s.score));
        }
      }
      if (out.length < limit) {
        const interactive = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]');
        for (const el of interactive) {
          if (out.length >= limit) break;
          if (seen.has(el)) continue;
          seen.add(el);
          out.push(describe(el, 0));
        }
      }
      return out;
    })()
  `;
}

/**
 * Rank and trim raw page candidates. Pure — all ordering policy lives here
 * rather than in page code, so it is unit-testable without a DOM.
 *
 * Visible candidates first, highest token score first, original order as the
 * final tiebreak. Hidden and zero-area candidates are appended ONLY when the
 * visible list is thin (< VISIBLE_FLOOR) and are capped at HIDDEN_CAP: a
 * selector that matched two hidden 0×0 twins is exactly the failure that made
 * `click` report success at (0,0), so they must never crowd out real answers.
 */
export function rankAlternatives(raw: AltCandidate[]): AltCandidate[] {
  const byScore = (a: AltCandidate, b: AltCandidate) => b.score - a.score;
  const visible = raw.filter((a) => a.visible).sort(byScore);
  if (visible.length >= VISIBLE_FLOOR) return visible.slice(0, RENDERED_CAP);
  const hidden = raw.filter((a) => !a.visible).sort(byScore).slice(0, HIDDEN_CAP);
  return [...visible, ...hidden].slice(0, RENDERED_CAP);
}

/**
 * Render the agent-facing hint block. Two lines per candidate: the metadata
 * line (with the ephemeral `@handle` when one was minted) and the selector on
 * its own line so it can be copied cleanly.
 *
 * Nothing downstream parses this string — change the template freely, but
 * change its test with it.
 */
export function renderAlternatives(alts: AltCandidate[]): string {
  if (!alts || alts.length === 0) return '';
  let out = 'Did you mean?';
  alts.forEach((alt, i) => {
    const parts: string[] = [];
    if (alt.handle) parts.push(`@${alt.handle}`);
    const caption = alt.text || alt.label;
    if (caption) parts.push(`"${caption}"`);
    parts.push(alt.tag);
    parts.push(alt.visible ? 'visible' : 'hidden');
    parts.push(`${alt.width}×${alt.height} @ (${alt.x},${alt.y})`);
    out += `\n  ${i + 1}. ${parts.join(' · ')}`;
    out += `\n     ${alt.selector}`;
  });
  return out;
}

/**
 * Find candidate elements for a failing selector.
 *
 * Two strategies, picked on the shape of the input:
 *   - `:has-text("...")` — scan for elements whose DIRECT text contains the phrase.
 *   - anything else — loosened token match (`playbooks/candidates.ts:selectorTokens`)
 *     plus an interactive-element sweep.
 *
 * The old `:has-text`-only precondition is gone: a plain CSS miss used to get
 * an empty list, which is the majority of real misses.
 *
 * Never throws — a blocked eval, a dead tab or a malformed selector all yield
 * `[]` and the caller prints the bare "Element not found" line.
 *
 * `sessionId` is unused here in Task 3; Task 4 consumes it to mint ephemeral
 * handles onto the ranked list.
 */
export async function findAlternativeSelectors(
  evalFn: EvalFn,
  selector: string,
  sessionId?: string,
): Promise<AltCandidate[]> {
  let expression: string;
  try {
    const m = selector.match(/:has-text\(["'](.+?)["']\)/);
    expression = m
      ? textCandidateExpression(m[1])
      : tokenCandidateExpression(selectorTokens(selector));
  } catch {
    return [];
  }

  try {
    const raw = await evalFn(expression);
    if (!Array.isArray(raw)) return [];
    const ranked = rankAlternatives(raw as AltCandidate[]);
    // Mint a throwaway `@name` per candidate that has a confident text source.
    // No session id => no binding => no handle: a process-global slot would have
    // no drop event and would leak for the process lifetime.
    // Builds new objects rather than mutating `ranked`'s elements in place —
    // those are the raw page-eval results, and mutating a caller-owned object
    // is surprising even though production `evalFn` calls always return fresh ones.
    if (sessionId) {
      const taken = new Set<string>();
      return ranked.map((alt) => {
        // A candidate no rung of the ladder could pin down gets NO name. This is
        // the "only name it when you can name it honestly" rule extended from
        // "has readable text" to "has a selector that resolves back to itself" —
        // the property the news.ycombinator.com defect proved was missing.
        if (alt.qualified === false) return alt;
        const name = mintHandleName({ text: alt.text, label: alt.label, tag: alt.tag }, taken);
        if (!name) return alt; // no confident text source — the CSS selector prints alone
        // `mintHandleName` names from `text || label`; guard the same one, using
        // the ellipsis-free, quote-free forms. Assumption A5: both can be empty
        // after sanitization even though the raw display forms were not.
        const matchSource = alt.matchText ? 'text' : (alt.matchLabel ? 'label' : null);
        bindEphemeral(sessionId, name, alt.selector, {
          matchSource,
          matchValue: matchSource === 'text' ? alt.matchText : (matchSource === 'label' ? alt.matchLabel : ''),
          x: alt.x,
          y: alt.y,
        });
        return { ...alt, handle: name };
      });
    }
    return ranked;
  } catch {
    return [];
  }
}

/**
 * Resolve a selector to its element's viewport-center coordinates.
 * On miss, throws an Error whose message carries the ranked candidate list.
 */
export async function getElementCenter(
  evalFn: EvalFn,
  selector: string,
  sessionId?: string,
): Promise<{ x: number; y: number }> {
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
    const hints = await findAlternativeSelectors(evalFn, selector, sessionId);
    let msg = `Element not found: \`${selector}\``;
    const block = renderAlternatives(hints);
    if (block) msg += `\n\n${block}`;
    throw new Error(msg);
  }
  return result;
}
