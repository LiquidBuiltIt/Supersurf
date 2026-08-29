/**
 * The Node-vm blocklist — Layer 1 for playbook scripts.
 *
 * Written fresh, NOT derived from the page blocklist in
 * `tools/browser_evaluate/secure-eval.ts`: a Node vm has no `window`, no
 * `document`, no `localStorage`, and no `navigator`, so those rules would be
 * meaningless here. What matters in a vm is module loading, escape to the host
 * realm via `constructor`, and reflection.
 *
 * These rules are a FILTER FOR CLEAR ERRORS, not containment. Static analysis
 * cannot decide what dynamic JavaScript does. The kernel-enforced boundary is
 * the child process (Layer 3); the vm context (Layer 2) is defense in depth.
 *
 * @module security/rules/node
 */
import type { RuleSet } from '../analyzer';
/** The blocklist applied to every playbook file. */
export declare const nodeRules: RuleSet;
/**
 * Applied ONLY when a playbook does not declare the `eval` permission.
 *
 * This is belt-and-braces. The real enforcement is by construction: when
 * `eval` is absent from `meta.permissions`, `supersurf.evaluate` is never
 * built onto the client object, so the call fails with "not a function"
 * regardless. This rule exists so the author gets a readable message at
 * validation time instead of a confusing one at run time.
 */
export declare const evalUsageRules: RuleSet;
//# sourceMappingURL=node.d.ts.map