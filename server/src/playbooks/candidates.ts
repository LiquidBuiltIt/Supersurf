/**
 * What a `SelectorMiss` gets instead of a page snapshot.
 *
 * The concrete failure this exists for: `.Layout-sidebar` stopped matching on
 * `github.com` because GitHub had renamed the element to
 * `SidebarAbout-module__description__xTkIP`. Finding that took three manual
 * `curl` calls. The failure record should have said it.
 *
 * Two passes, in this order:
 *   1. LOOSENED MATCH — strip the selector to its distinctive lowercase
 *      fragments and re-query by substring. It finds the answer whenever a name
 *      partly survived a rename (`sidebar` still appears in `SidebarAbout`).
 *   2. INTERACTIVE FALLBACK — the page's links, buttons and inputs. Always
 *      populated, rarely the answer when the target was a plain container, but
 *      it is the only thing left when the name changed wholesale (`tr.zA`).
 *
 * Neither alone covers both cases. Together they stay under the 4 KB evidence
 * cap, against 766 KB for the accessibility tree this replaces.
 *
 * NOT `browser_snapshot`: that is `Accessibility.getFullAXTree`, whose nodes
 * carry `role`/`name`/`backendDOMNodeId` and no class names at all — it cannot
 * answer a "what is this called now?" question at any size.
 *
 * @module playbooks/candidates
 */

/** One suggestion. Kept deliberately thin: a selector, and enough text to recognise it. */
export interface Candidate {
  selector: string;
  text?: string;
}

/** Hard cap on suggestions. Eight is enough to spot a rename and small enough to read. */
export const MAX_CANDIDATES = 8;

/** Per-candidate text budget, so one verbose node cannot eat the whole record. */
const MAX_TEXT = 60;

/** Page-level text budgets. Both are page-controlled strings. */
const MAX_TITLE = 120;
const MAX_URL = 200;

/** The narrow slice of the runner's backend this needs. */
export interface CandidateBackend {
  callTool(name: string, args: Record<string, unknown>, options?: { rawResult?: boolean }): Promise<any>;
}

/**
 * Fragments too common to discriminate. A candidate list ranked on 'div' or
 * 'data' is a list of the whole page.
 */
const STOP = new Set([
  'div', 'span', 'html', 'body', 'main', 'footer', 'section',
  'true', 'false', 'type', 'role', 'data', 'class', 'href', 'item', 'text',
]);

/** Below this, a fragment matches too much to be a signal. */
const MIN_TOKEN = 4;

/**
 * Reduce a selector to the lowercase fragments worth substring-matching on.
 *
 * `.Layout-sidebar` -> `['layout', 'sidebar']`, and `sidebar` is what survives
 * into `SidebarAbout-module__description__xTkIP`. `tr.zA` -> `[]`, which is
 * correct: nothing about `zA` is a usable signal, so the caller falls through
 * to the interactive sweep.
 */
export function selectorTokens(selector: string): string[] {
  const words = selector.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    // Split on separators AND at camelCase boundaries: a CSS-module name packs
    // both (SidebarAbout-module__description).
    for (const part of word.split(/[-_]+|(?<=[a-z0-9])(?=[A-Z])/)) {
      const token = part.toLowerCase();
      if (token.length < MIN_TOKEN || STOP.has(token) || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/**
 * Build the page expression. Read-only DOM plus string work only — nothing here
 * should trip `secure_eval`, but the caller treats a block as a non-event.
 */
export function candidateExpression(tokens: string[], limit: number): string {
  return `() => {
    const tokens = ${JSON.stringify(tokens)};
    const limit = ${limit};
    const describe = (el) => {
      let sel = el.tagName.toLowerCase();
      if (el.id) sel += '#' + el.id;
      else if (typeof el.className === 'string' && el.className.trim()) {
        sel += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
      }
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      return { selector: sel, text: text.slice(0, ${MAX_TEXT}) };
    };

    const out = [];
    if (tokens.length > 0) {
      const scored = [];
      for (const el of document.querySelectorAll('*')) {
        const hay = (el.id + ' ' + (typeof el.className === 'string' ? el.className : '')
          + ' ' + (el.getAttribute('data-testid') || '')).toLowerCase();
        if (!hay.trim()) continue;
        let score = 0;
        for (const t of tokens) if (hay.indexOf(t) !== -1) score++;
        if (score > 0) scored.push({ score: score, el: el });
      }
      scored.sort((a, b) => b.score - a.score);
      for (const s of scored.slice(0, limit)) out.push(describe(s.el));
    }

    if (out.length < limit) {
      const interactive = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]');
      for (const el of interactive) {
        if (out.length >= limit) break;
        out.push(describe(el));
      }
    }

    return { url: location.href, title: document.title, candidates: out };
  }`;
}

/**
 * Best-effort. NEVER throws, and never turns a failed run into a differently
 * failed run — a blocked eval, a crashed renderer, or a closed tab all come
 * back as `undefined` and the record simply carries no candidates.
 */
export async function captureCandidates(
  backend: CandidateBackend,
  selector: string,
): Promise<{ url?: string; title?: string; candidates: Candidate[] } | undefined> {
  try {
    // Inside the try, not above it. `selectorTokens` calls `selector.match`,
    // which throws on a non-string — and the runner's cast to `string` is
    // compile-time only. A throw escaping here escapes `runPlaybook` before
    // teardown and leaks the run's tab.
    const expression = candidateExpression(selectorTokens(selector), MAX_CANDIDATES);
    const res: any = await backend.callTool(
      'browser_evaluate',
      { function: expression, purpose: 'playbook:failure-candidates' },
      { rawResult: true },
    );
    if (!res || res.success === false) return undefined;
    const raw = Array.isArray(res.candidates) ? res.candidates : [];
    const candidates: Candidate[] = raw
      .slice(0, MAX_CANDIDATES)
      .map((c: any) => {
        const out: Candidate = { selector: String(c?.selector ?? '') };
        const text = typeof c?.text === 'string' ? c.text.slice(0, MAX_TEXT) : '';
        if (text) out.text = text;
        return out;
      })
      .filter((c: Candidate) => c.selector);

    // Both capped: `fitEvidence` sheds only candidates, so an uncapped `url` —
    // a long `data:` or `blob:` `location.href` — pushes the record past
    // MAX_EVIDENCE_CHARS with nothing left to drop.
    const result: { url?: string; title?: string; candidates: Candidate[] } = { candidates };
    if (typeof res.url === 'string') result.url = res.url.slice(0, MAX_URL);
    if (typeof res.title === 'string') result.title = res.title.slice(0, MAX_TITLE);
    return result;
  } catch {
    return undefined;
  }
}
