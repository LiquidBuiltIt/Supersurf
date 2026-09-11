/**
 * Static validation of playbook element-target arguments.
 *
 * A verb (`supersurf.click`, `supersurf.hover`, …) takes an element target as
 * its first argument. This module enforces three things about that argument,
 * entirely from the source text — it opens no browser and reads no page:
 *
 *   1. The argument's FORM must be one of exactly two legal shapes: a plain
 *      string literal, or an identifier `const`-bound to one in the same
 *      module. Concatenation, template interpolation, member expressions,
 *      loop variables and function parameters are all rejected — on FORM,
 *      not on whether the value happens to be resolvable. This keeps the
 *      rule one sentence long and the error message self-explanatory,
 *      matching `parseMeta`'s "meta must be a pure literal" posture.
 *
 *   2. A `@`-prefixed target (a handle reference, per `isHandleRef` in
 *      `handle-resolve.ts`) must already be RECORDED — a `FingerprintRecord`
 *      somewhere in `~/.supersurf/fingerprints/` must carry that name in its
 *      `handleName` field. This is a REJECTION, not a warning: the store is a
 *      local file, so the cost of checking now is a stat and a JSON parse,
 *      against the cost of finding out on a live page mid-run.
 *
 *      WHY a handle name is authored by a human, never derived positionally:
 *      a derived name (`click_step_3`) breaks the moment a step is inserted
 *      or reordered, and a fingerprint only resolves back to the same element
 *      if the SAME name is used to look it up on every run that follows the
 *      run that captured it. Positional names have no such stability.
 *
 *   3. A NON-`@` target (a raw CSS selector) is rejected unless
 *      `meta.useRawSelectors` is `true`. This is a PERMISSION GATE, not an
 *      exemption: the default is strict (every target must be a handle), and
 *      the flag ADDITIONALLY permits raw selectors alongside handles — it
 *      never turns off checks 1 or 2. See `meta.ts` for the flag itself.
 *
 * @module security/element-targets
 */
import type { PlaybookMeta } from './meta';
/**
 * Validate every element-target argument in a playbook's source. Returns
 * `{}` on success, `{ error }` naming the first offending target found.
 *
 * Never throws: unparseable source is not this function's error to report —
 * `parseMeta`/`analyzeWithRules` already surface a syntax error for it, and
 * `validateFile` calls this only after both have already accepted the file.
 */
export declare function validateElementTargets(source: string, meta: PlaybookMeta): {
    error?: string;
};
//# sourceMappingURL=element-targets.d.ts.map