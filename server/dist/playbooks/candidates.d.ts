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
export declare const MAX_CANDIDATES = 8;
/** The narrow slice of the runner's backend this needs. */
export interface CandidateBackend {
    callTool(name: string, args: Record<string, unknown>, options?: {
        rawResult?: boolean;
    }): Promise<any>;
}
/**
 * Reduce a selector to the lowercase fragments worth substring-matching on.
 *
 * `.Layout-sidebar` -> `['layout', 'sidebar']`, and `sidebar` is what survives
 * into `SidebarAbout-module__description__xTkIP`. `tr.zA` -> `[]`, which is
 * correct: nothing about `zA` is a usable signal, so the caller falls through
 * to the interactive sweep.
 */
export declare function selectorTokens(selector: string): string[];
/**
 * Build the page expression. Read-only DOM plus string work only — nothing here
 * should trip `secure_eval`, but the caller treats a block as a non-event.
 */
export declare function candidateExpression(tokens: string[], limit: number): string;
/**
 * Best-effort. NEVER throws, and never turns a failed run into a differently
 * failed run — a blocked eval, a crashed renderer, or a closed tab all come
 * back as `undefined` and the record simply carries no candidates.
 */
export declare function captureCandidates(backend: CandidateBackend, selector: string): Promise<{
    url?: string;
    title?: string;
    candidates: Candidate[];
} | undefined>;
//# sourceMappingURL=candidates.d.ts.map