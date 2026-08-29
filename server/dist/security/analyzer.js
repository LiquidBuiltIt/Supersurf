"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeWithRules = analyzeWithRules;
const acorn = __importStar(require("acorn"));
const walk = __importStar(require("acorn-walk"));
const DEFAULT_PARSE_OPTIONS = {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
};
/**
 * Node types the walker visits. Adding a type here is the only way a pattern
 * with a new `nodeType` will ever fire — a pattern whose nodeType is not in
 * this list is dead code.
 */
const WALKED_NODE_TYPES = [
    'CallExpression',
    'MemberExpression',
    'NewExpression',
    'ImportExpression',
    'TaggedTemplateExpression',
    'Literal',
];
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
function analyzeWithRules(code, rules) {
    if (!code || !code.trim()) {
        return { safe: true };
    }
    let ast;
    try {
        ast = acorn.parse(code, {
            ...DEFAULT_PARSE_OPTIONS,
            ...(rules.parseOptions ?? {}),
        });
    }
    catch {
        // Syntax errors → let the caller return its own error
        return { safe: true };
    }
    let violation = null;
    const visitors = {};
    for (const nodeType of WALKED_NODE_TYPES) {
        visitors[nodeType] = (node, _state, ancestors) => {
            if (violation)
                return;
            for (const pattern of rules.patterns) {
                if (pattern.nodeType === nodeType && pattern.matcher(node, ancestors)) {
                    violation = { safe: false, reason: pattern.reason };
                    return;
                }
            }
        };
    }
    walk.ancestor(ast, visitors);
    return violation ?? { safe: true };
}
//# sourceMappingURL=analyzer.js.map