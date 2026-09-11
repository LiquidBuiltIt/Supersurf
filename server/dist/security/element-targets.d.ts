/**
 * Static validation of playbook element-target arguments.
 *
 * A verb (`supersurf.click`, `supersurf.hover`, …) takes an element target as
 * one of its arguments. This module enforces four things about that argument,
 * entirely from the source text — it opens no browser and reads no page:
 *
 *   1. The CALL FORM must be `supersurf.<method>(...)` — a direct, non-computed
 *      member call on the `supersurf` identifier. This is a validation GATE:
 *      any call form this analyzer cannot positively verify is REJECTED, never
 *      silently skipped. Destructuring `supersurf` (`const { click } =
 *      supersurf`), assigning one of its members to a variable (`const c =
 *      supersurf.click`), computed member access (`supersurf['click']`), and
 *      aliasing the whole client object itself to another name (`let s2 =
 *      supersurf`, or the bare assignment `s2 = supersurf`) all escape a naive
 *      `callee.object.name === 'supersurf'` check — each is rejected outright,
 *      by name, rather than treated as "not a target call" and let through.
 *      The object-alias case matters most of the four: it is a normal
 *      brevity idiom, not an attack shape, so an honest author who writes
 *      `let s2 = supersurf` for convenience silently loses every check in the
 *      file with no error and no signal — exactly the failure mode this gate
 *      exists to catch. An allowlist-and-skip walker is backwards for a
 *      security gate: the default for anything unrecognized must be reject,
 *      not pass.
 *
 *      KNOWN, ACCEPTED GAP — not fixed: aggregating `supersurf` into a
 *      structure before calling through it, e.g. `const arr = [supersurf];
 *      arr[0].click(...)`, is not detected. Closing it needs binding-level
 *      taint tracking of the `supersurf` identifier through arbitrary
 *      structures — the scope analysis this module deliberately does not
 *      build (see point 2). Accepted because the sandbox (`security/sandbox/`)
 *      and `meta.permissions` are the actual runtime enforcement boundary;
 *      this module is a pre-flight correctness gate that catches the honest
 *      mistakes and the cheap-to-detect bypasses, not a substitute for the
 *      sandbox.
 *
 *   2. The argument's FORM must be one of exactly two legal shapes: a plain
 *      string literal, or an identifier `const`-bound to one in the same
 *      module. Concatenation, template interpolation, member expressions,
 *      loop variables and function parameters are all rejected — on FORM,
 *      not on whether the value happens to be resolvable. This keeps the
 *      rule one sentence long and the error message self-explanatory,
 *      matching `parseMeta`'s "meta must be a pure literal" posture.
 *
 *      A `const`-bound identifier is resolved only when its name is bound to
 *      a string literal EXACTLY ONCE anywhere in the module. A name bound
 *      more than once (e.g. two different `const h = '...'` in two different
 *      functions) is REJECTED, not resolved first-wins: first-wins is an
 *      exploitable false pass in one direction (an unrelated `const h =
 *      '@recorded'` masks a real unrecorded binding elsewhere) and a false
 *      reject in the other (an unrelated `const h = '#raw'` masks a legal
 *      recorded handle elsewhere). Proper scope tracking would close this too,
 *      but is more machinery than this check needs — rejecting the ambiguity
 *      outright is one sentence and closes both directions at once. This is a
 *      real, exploitable gap the ambiguity check closes, not a stylistic
 *      simplification.
 *
 *   3. A `@`-prefixed target (a handle reference, per `isHandleRef` in
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
 *   4. A NON-`@` target (a raw CSS selector) is rejected unless
 *      `meta.useRawSelectors` is `true`. This is a PERMISSION GATE, not an
 *      exemption: the default is strict (every target must be a handle), and
 *      the flag ADDITIONALLY permits raw selectors alongside handles — it
 *      never turns off checks 1-3. See `meta.ts` for the flag itself.
 *
 * `wait` and `drag` are element-target-bearing verbs too, and are checked
 * with the same rules above, NOT excluded:
 *
 *   - `wait(msOrSelector)` is a union (`command-map.ts`): a NUMERIC literal is
 *     a delay and is not checked at all; a STRING literal or `const`-bound
 *     string is a wait-for-element selector and gets the full check (form,
 *     handle-existence, raw-selector gate). Anything else (template literal,
 *     concatenation, member expression, an identifier that isn't a
 *     `const`-bound string) is an illegal form under check 2 — the analyzer
 *     does not need to know it is a delay-or-selector union to reject those;
 *     it only needs to skip the one shape (a bare numeric literal) that is
 *     unambiguously never a target.
 *   - `drag(from, to)` (`command-map.ts`) takes TWO element targets, both
 *     checked independently under the same rules. That the sandbox's param
 *     names are `from`/`to` rather than `selector` is a naming detail of
 *     `sandbox/methods.ts`, not a reason to exempt either argument.
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