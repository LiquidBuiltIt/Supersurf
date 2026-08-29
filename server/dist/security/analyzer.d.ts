/**
 * Rule-driven static analysis — the shared acorn walker.
 *
 * This module knows HOW to walk JavaScript looking for blocked patterns. It
 * knows nothing about WHICH patterns matter; callers supply a {@link RuleSet}.
 * Two rule sets exist today: the page blocklist in
 * `tools/browser_evaluate/secure-eval.ts` (BLOCKED_PATTERNS) and the Node-vm
 * blocklist in `security/rules/node.ts` (nodeRules).
 *
 * This is Layer 1 of the sandbox: a filter for clear errors, NOT containment.
 * Static analysis cannot decide what dynamic JavaScript does. Containment is
 * the child process (Layer 3).
 *
 * @module security/analyzer
 */
/** Result of static code analysis — safe to execute or blocked with a reason. */
export interface AnalysisResult {
    safe: boolean;
    reason?: string;
}
/**
 * A single blocked pattern definition.
 * Each pattern targets a specific AST node type and uses a matcher function
 * to inspect the node (and its ancestor chain) for dangerous constructs.
 */
export interface BlockedPattern {
    nodeType: string;
    matcher: (node: any, ancestors: any[]) => boolean;
    reason: string;
}
/** A named collection of patterns plus optional acorn parse overrides. */
export interface RuleSet {
    patterns: BlockedPattern[];
    /** Merged over the defaults: ecmaVersion 'latest', sourceType 'module',
     *  allowReturnOutsideFunction, allowAwaitOutsideFunction. */
    parseOptions?: Record<string, unknown>;
}
/**
 * Statically analyze JavaScript against a rule set.
 *
 * Parses with acorn, walks with acorn-walk's ancestor traversal, and returns on
 * the first violation. Unparseable code returns `{ safe: true }` — callers
 * surface their own syntax errors rather than blocking potentially valid code.
 *
 * @param code - JavaScript source to analyze
 * @param rules - Patterns to match, plus optional parse-option overrides
 * @returns safe=true, or safe=false with the matched pattern's reason
 */
export declare function analyzeWithRules(code: string, rules: RuleSet): AnalysisResult;
//# sourceMappingURL=analyzer.d.ts.map