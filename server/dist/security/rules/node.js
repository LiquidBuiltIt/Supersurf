"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.evalUsageRules = exports.nodeRules = void 0;
/** Check if a node is an Identifier with the given name. */
function isIdentifier(node, name) {
    return node?.type === 'Identifier' && node.name === name;
}
/** Check if a callee is a non-computed member expression like `obj.prop`. */
function isMemberCall(callee, obj, prop) {
    return (callee?.type === 'MemberExpression' &&
        isIdentifier(callee.object, obj) &&
        !callee.computed &&
        isIdentifier(callee.property, prop));
}
/** Node host globals a playbook must never touch. None of them exist in the
 *  sandbox context — they are absent by omission — but naming them turns a
 *  baffling `process is not defined` into a readable validation error. */
/**
 * Names that reach a prototype, and through it the host realm. The two
 * `__lookup*__` accessors belong here for the same reason `__proto__` does:
 * `({}).__lookupGetter__('__proto__')` hands back Object.prototype's own
 * getter, which returns a prototype when called — the same walk, one
 * indirection further out, and invisible to a rule that only knows the two
 * obvious names.
 */
const PROTO_WALK = ['__proto__', 'constructor', '__lookupGetter__', '__lookupSetter__'];
const HOST_GLOBALS = ['process', 'global', 'globalThis', 'require', 'module', 'exports', 'Buffer', '__dirname', '__filename'];
/** Code-generation entry points. `codeGeneration: { strings: false }` already
 *  makes these throw inside the vm; blocking them statically explains why. */
const CODEGEN = ['eval', 'Function'];
/** Prototype-manipulation statics on `Object` — the descriptor/proto escape family. */
const OBJECT_PROTO_STATICS = [
    'getPrototypeOf', 'setPrototypeOf', 'defineProperty', 'defineProperties',
    'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors',
];
const patterns = [
    // ── Module loading ────────────────────────────────────────
    {
        nodeType: 'CallExpression',
        matcher: (node) => isIdentifier(node.callee, 'require'),
        reason: 'require() is not available in a playbook — playbooks have no module system',
    },
    {
        nodeType: 'ImportExpression',
        matcher: () => true,
        reason: 'Dynamic import() is not available in a playbook',
    },
    {
        // acorn-walk's base visitor for ImportDeclaration / ExportNamedDeclaration
        // with a source walks into `node.source`, which is a Literal. Catching it
        // there means no seventh node type is needed in the walker.
        nodeType: 'Literal',
        matcher: (_node, ancestors) => {
            const parent = ancestors[ancestors.length - 2];
            return parent?.type === 'ImportDeclaration' ||
                parent?.type === 'ExportNamedDeclaration' ||
                parent?.type === 'ExportAllDeclaration';
        },
        reason: 'Static import/re-export from a module is not available in a playbook',
    },
    // ── Host realm escape ─────────────────────────────────────
    {
        nodeType: 'MemberExpression',
        matcher: (node) => {
            if (node.property?.type === 'Identifier') {
                return PROTO_WALK.includes(node.property.name);
            }
            if (node.property?.type === 'Literal' && typeof node.property.value === 'string') {
                return PROTO_WALK.includes(node.property.value);
            }
            return false;
        },
        reason: 'Prototype chain walking (__proto__ / constructor) — this is the classic vm escape',
    },
    {
        nodeType: 'MemberExpression',
        matcher: (node) => node.object?.type === 'Identifier' && HOST_GLOBALS.includes(node.object.name),
        reason: 'Node host global is not available in a playbook (process/global/globalThis/require/module/exports/Buffer)',
    },
    {
        nodeType: 'CallExpression',
        matcher: (node) => node.callee?.type === 'Identifier' && HOST_GLOBALS.includes(node.callee.name),
        reason: 'Node host global is not available in a playbook (process/global/globalThis/require/module/exports/Buffer)',
    },
    {
        nodeType: 'CallExpression',
        matcher: (node) => node.callee?.type === 'Identifier' && CODEGEN.includes(node.callee.name),
        reason: 'Dynamic code generation (eval / Function) is disabled in the playbook sandbox',
    },
    {
        nodeType: 'NewExpression',
        matcher: (node) => node.callee?.type === 'Identifier' && CODEGEN.includes(node.callee.name),
        reason: 'Dynamic code generation (eval / Function) is disabled in the playbook sandbox',
    },
    {
        nodeType: 'MemberExpression',
        matcher: (node) => isIdentifier(node.object, 'WebAssembly'),
        reason: 'Dynamic code generation (WebAssembly) is disabled in the playbook sandbox',
    },
    // ── Reflection ────────────────────────────────────────────
    {
        nodeType: 'MemberExpression',
        matcher: (node) => isIdentifier(node.object, 'Reflect'),
        reason: 'Reflection API (Reflect.*) is blocked in a playbook',
    },
    {
        nodeType: 'NewExpression',
        matcher: (node) => isIdentifier(node.callee, 'Proxy'),
        reason: 'Reflection API (Proxy) is blocked in a playbook',
    },
    {
        nodeType: 'CallExpression',
        matcher: (node) => OBJECT_PROTO_STATICS.some(p => isMemberCall(node.callee, 'Object', p)),
        reason: 'Prototype manipulation (Object.getPrototypeOf / setPrototypeOf / defineProperty / getOwnPropertyDescriptor) is blocked in a playbook',
    },
];
/** The blocklist applied to every playbook file. */
exports.nodeRules = { patterns };
/**
 * Applied ONLY when a playbook does not declare the `eval` permission.
 *
 * This is belt-and-braces. The real enforcement is by construction: when
 * `eval` is absent from `meta.permissions`, `supersurf.evaluate` is never
 * built onto the client object, so the call fails with "not a function"
 * regardless. This rule exists so the author gets a readable message at
 * validation time instead of a confusing one at run time.
 */
exports.evalUsageRules = {
    patterns: [{
            nodeType: 'MemberExpression',
            matcher: (node) => isIdentifier(node.object, 'supersurf') && !node.computed && isIdentifier(node.property, 'evaluate'),
            reason: 'supersurf.evaluate() requires "eval" in the meta.permissions array',
        }],
};
//# sourceMappingURL=node.js.map