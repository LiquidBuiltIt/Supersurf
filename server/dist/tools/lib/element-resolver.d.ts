/** Async page evaluator signature (matches the inner closure of `evalExpr`). */
export type EvalFn = (expression: string, awaitPromise?: boolean) => Promise<any>;
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
export declare function getSelectorExpression(selector: string): string;
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
export declare function getAllSelectorExpression(selector: string): string;
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
export declare const DESCRIBE_SOURCE = "\n  const describe = (el, score) => {\n    const esc = (s) => CSS.escape(String(s));\n    let sel = el.tagName.toLowerCase();\n    if (el.id) {\n      sel += '#' + esc(el.id);\n    } else if (el.className && typeof el.className === 'string' && el.className.trim()) {\n      const cls = el.className.trim().split(/\\s+/).filter(Boolean);\n      if (cls.length > 0) sel += '.' + cls.slice(0, 2).map(esc).join('.');\n    } else if (el.getAttribute('role')) {\n      sel += '[role=\"' + el.getAttribute('role') + '\"]';\n    }\n    let directText = '';\n    for (const n of el.childNodes) {\n      if (n.nodeType === Node.TEXT_NODE) directText += n.textContent;\n    }\n    directText = directText.trim().replace(/\\s+/g, ' ');\n    const label = el.getAttribute('aria-label') || el.getAttribute('title')\n      || el.getAttribute('placeholder') || (typeof el.value === 'string' ? el.value : '')\n      || el.getAttribute('alt') || '';\n    const rect = el.getBoundingClientRect();\n    const style = window.getComputedStyle(el);\n    const qualified = qualify(el, sel);\n    return {\n      selector: qualified.selector,\n      qualified: qualified.source !== null,\n      tag: el.tagName.toLowerCase(),\n      visible: style.display !== 'none' && style.visibility !== 'hidden'\n        && style.opacity !== '0' && rect.width > 0 && rect.height > 0,\n      text: directText.length > 50 ? directText.slice(0, 50) + '...' : directText,\n      matchText: ssSafe(directText),\n      label: String(label).replace(/\\s+/g, ' ').trim().slice(0, 50),\n      matchLabel: ssSafe(label),\n      x: Math.round(rect.left + rect.width / 2),\n      y: Math.round(rect.top + rect.height / 2),\n      width: Math.round(rect.width),\n      height: Math.round(rect.height),\n      score: score,\n    };\n  };\n";
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
export declare function rankAlternatives(raw: AltCandidate[]): AltCandidate[];
/**
 * Render the agent-facing hint block. Two lines per candidate: the metadata
 * line (with the ephemeral `@handle` when one was minted) and the selector on
 * its own line so it can be copied cleanly.
 *
 * Nothing downstream parses this string — change the template freely, but
 * change its test with it.
 */
export declare function renderAlternatives(alts: AltCandidate[]): string;
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
export declare function findAlternativeSelectors(evalFn: EvalFn, selector: string, sessionId?: string): Promise<AltCandidate[]>;
/**
 * Resolve a selector to its element's viewport-center coordinates.
 * On miss, throws an Error whose message carries the ranked candidate list.
 * Also returns the resolved element's direct text and accessible-name label —
 * one extra property on a round trip that already happens, so a caller holding
 * mint-time identity facts can verify it reached the right element before
 * dispatching any input.
 */
export declare function getElementCenter(evalFn: EvalFn, selector: string, sessionId?: string): Promise<{
    x: number;
    y: number;
    text: string;
    label: string;
}>;
//# sourceMappingURL=element-resolver.d.ts.map