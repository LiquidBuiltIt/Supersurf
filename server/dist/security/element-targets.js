"use strict";
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
exports.validateElementTargets = validateElementTargets;
const acorn = __importStar(require("acorn"));
const walk = __importStar(require("acorn-walk"));
const methods_1 = require("./sandbox/methods");
const handle_resolve_1 = require("../experimental/fingerprinting/handle-resolve");
const naming_1 = require("../experimental/fingerprinting/naming");
const store_1 = require("../experimental/fingerprinting/store");
/**
 * `supersurf.<method>` calls whose first positional argument is an element
 * target and which take exactly one target — derived from `METHODS` itself
 * (single source of truth) rather than a hand-maintained duplicate list, so a
 * future verb whose first param is named `selector` is picked up
 * automatically. Namespaced passthroughs (`tabs.list`, …) never have a
 * `selector` first param, so the `.` filter only excludes paths that could
 * never match anyway.
 *
 * `wait` and `drag` are deliberately NOT in this set — both take an element
 * target, but neither fits the "single `selector`-named first param" shape
 * this set captures (`wait`'s sole param is the delay-or-selector union
 * `msOrSelector`; `drag` takes two params, `from` and `to`). Both are handled
 * by dedicated branches in the walker below, not skipped.
 */
const TARGET_METHODS = new Set(Object.entries(methods_1.METHODS)
    .filter(([path, spec]) => !path.includes('.') && spec.params[0] === 'selector')
    .map(([path]) => path));
/**
 * Resolve a call argument to its element-target string, or reject its FORM.
 * The only resolution performed is constant-folding a `const`-bound
 * identifier to the string literal it was declared with — nothing else is
 * ever evaluated, matching `meta.ts`'s "parsed, never executed" posture. A
 * name bound to a string literal more than once in the module is treated as
 * unresolvable (see the module doc comment, point 2) rather than resolved to
 * whichever binding was seen first.
 */
function resolveTarget(node, constStrings, ambiguousConstNames) {
    switch (node.type) {
        case 'Literal':
            if (typeof node.value === 'string')
                return { value: node.value };
            return { formError: `is a ${typeof node.value} literal — an element target must be a string` };
        case 'Identifier': {
            if (ambiguousConstNames.has(node.name)) {
                return {
                    formError: `is the identifier \`${node.name}\`, which is \`const\`-bound to a string literal more than ` +
                        `once in this module — the analyzer will not guess which binding is live`,
                };
            }
            const bound = constStrings.get(node.name);
            if (bound !== undefined)
                return { value: bound };
            return {
                formError: `is the identifier \`${node.name}\`, which is not \`const\`-bound to a string literal in this module ` +
                    `(a loop variable or function parameter is not one of the two legal forms)`,
            };
        }
        case 'TemplateLiteral':
            return { formError: 'is a template literal — use a plain string literal or a `const`-bound identifier instead' };
        case 'BinaryExpression':
            return { formError: 'is built by string concatenation — use a plain string literal or a `const`-bound identifier instead' };
        case 'MemberExpression':
            return { formError: 'is a member expression — use a plain string literal or a `const`-bound identifier instead' };
        default:
            return {
                formError: `has an unsupported form (${node.type}) — only a plain string literal or a \`const\`-bound identifier is allowed`,
            };
    }
}
/** True when some record anywhere in `store` carries this exact handle name. */
function storeHasHandle(store, normalized) {
    for (const byRoute of Object.values(store.routes)) {
        for (const rec of Object.values(byRoute)) {
            if (rec.handleName === normalized)
                return true;
        }
    }
    return false;
}
/**
 * True when `normalized` is recorded as a `handleName` anywhere on disk.
 *
 * `startingPoint` is a search HINT, not a scope rule: its domain file is read
 * first purely as an optimization (the common case — a script's own handles
 * live under its own starting domain), but every other domain file is still
 * scanned on a miss. A handle name is an identifier, not a path-scoped
 * lookup — narrowing by domain here would change the verdict, not just the
 * order of work, which is exactly the shortcut this function must not take.
 */
function handleIsRecorded(normalized, startingPoint) {
    if (!normalized)
        return false;
    // Mirrors `playbooks/report.ts`'s `startPoint()` normalization so a
    // `meta.startingPoint` of 'X.com' or 'www.x.com' still hits the same file
    // `domainOf()` would have written the fingerprints under.
    const hintDomain = typeof startingPoint === 'string' && startingPoint.trim()
        ? startingPoint.trim().toLowerCase().replace(/^www\./, '')
        : null;
    if (hintDomain && storeHasHandle((0, store_1.loadDomain)(hintDomain), normalized))
        return true;
    for (const store of (0, store_1.loadAllDomains)()) {
        if (hintDomain && store.domain === hintDomain)
            continue; // already checked above
        if (storeHasHandle(store, normalized))
            return true;
    }
    return false;
}
/**
 * Validate every element-target argument in a playbook's source. Returns
 * `{}` on success, `{ error }` naming the first offending target found.
 *
 * Never throws: unparseable source is not this function's error to report —
 * `parseMeta`/`analyzeWithRules` already surface a syntax error for it, and
 * `validateFile` calls this only after both have already accepted the file.
 */
function validateElementTargets(source, meta) {
    let ast;
    try {
        ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    }
    catch {
        return {};
    }
    let error = null;
    // Pass 1: collect every `const <id> = '<literal>'` binding in the module
    // (the only resolution step check 2 performs — constant-folding), AND
    // reject the two illegal `supersurf`-binding forms outright, wherever in
    // the module they appear, independent of whether the resulting binding is
    // ever called. This is a structural reject, not a data-flow trace: it is
    // simpler than tracking an alias through to its call site, and it closes
    // the same hole either way.
    const rawConstStrings = new Map();
    walk.simple(ast, {
        VariableDeclaration(node) {
            if (node.kind !== 'const')
                return;
            for (const d of node.declarations) {
                if (d.id?.type === 'Identifier' && d.init?.type === 'Literal' && typeof d.init.value === 'string') {
                    const arr = rawConstStrings.get(d.id.name) ?? [];
                    arr.push(d.init.value);
                    rawConstStrings.set(d.id.name, arr);
                }
            }
        },
        VariableDeclarator(node) {
            if (error)
                return;
            // `const { click } = supersurf` / `let { click } = supersurf` — any
            // destructuring of the supersurf client object.
            if (node.init?.type === 'Identifier' && node.init.name === 'supersurf' && node.id?.type === 'ObjectPattern') {
                error =
                    'playbook destructures the `supersurf` client object (`const { ... } = supersurf`) — call verbs ' +
                        'directly as `supersurf.click(...)`, not through a destructured binding';
                return;
            }
            // `const c = supersurf.click` — assigning any supersurf member to a
            // variable, then calling the variable instead of `supersurf.<method>`.
            if (node.init?.type === 'MemberExpression' &&
                node.init.object?.type === 'Identifier' &&
                node.init.object.name === 'supersurf') {
                error =
                    'playbook assigns a `supersurf` member to a variable (`const c = supersurf.click`) — call verbs ' +
                        'directly as `supersurf.click(...)`, not through an aliased binding';
                return;
            }
            // `let s2 = supersurf` — aliasing the whole client object itself, not
            // one of its members, to another name. An honest author reaching for
            // brevity loses every check in this file with no error and no signal,
            // which is exactly the failure mode this gate exists to catch — so it
            // is rejected by name alongside member-aliasing and destructuring,
            // even though nothing downstream calls through `s2` in this example.
            if (node.id?.type === 'Identifier' && node.init?.type === 'Identifier' && node.init.name === 'supersurf') {
                error =
                    'playbook aliases the `supersurf` client object itself to a variable (`let s2 = supersurf`) — call ' +
                        'verbs directly as `supersurf.click(...)`, not through an aliased binding';
                return;
            }
        },
        AssignmentExpression(node) {
            if (error)
                return;
            // `s2 = supersurf` — the same object-alias bypass, written as a bare
            // assignment instead of a declaration.
            if (node.operator === '=' &&
                node.left?.type === 'Identifier' &&
                node.right?.type === 'Identifier' &&
                node.right.name === 'supersurf') {
                error =
                    'playbook aliases the `supersurf` client object itself to a variable (`s2 = supersurf`) — call verbs ' +
                        'directly as `supersurf.click(...)`, not through an aliased binding';
            }
        },
    });
    if (error)
        return { error };
    const constStrings = new Map();
    const ambiguousConstNames = new Set();
    for (const [name, values] of rawConstStrings) {
        if (values.length > 1)
            ambiguousConstNames.add(name);
        else
            constStrings.set(name, values[0]);
    }
    /** Checks 2-4 for one element-target argument. Returns an error message, or null. */
    function checkTarget(method, argNode) {
        const resolved = resolveTarget(argNode, constStrings, ambiguousConstNames);
        if (resolved.formError) {
            return `supersurf.${method}(...): element target ${resolved.formError}`;
        }
        const raw = resolved.value;
        if ((0, handle_resolve_1.isHandleRef)(raw)) {
            const normalized = (0, naming_1.normalizeName)(raw.slice(1));
            if (!handleIsRecorded(normalized, meta.startingPoint)) {
                return (`supersurf.${method}('${raw}'): no recorded handle named "${normalized}" in ` +
                    `~/.supersurf/fingerprints/ — drive the task live first so the element is captured ` +
                    `under this name, or check the spelling`);
            }
            return null;
        }
        if (!meta.useRawSelectors) {
            return (`supersurf.${method}('${raw}'): raw CSS selectors are not allowed — element targets must ` +
                `be handles (\`@name\`) unless meta.useRawSelectors is true (a permission gate that ` +
                `ADDITIONALLY allows raw selectors; it does not turn off the handle check)`);
        }
        return null;
    }
    // Pass 2: walk every call, allowlisting exactly one legal call form
    // (`supersurf.<method>(...)`, non-computed) and rejecting everything else
    // that touches `supersurf` by member access, rather than silently skipping
    // a shape this analyzer does not recognize.
    walk.simple(ast, {
        CallExpression(node) {
            if (error)
                return;
            const callee = node.callee;
            // A bare-identifier callee (`click(...)`, `helper(...)`) is not a
            // `supersurf.*` member call. It is not silently trusted, either: if it
            // resulted from destructuring or aliasing `supersurf`, Pass 1 already
            // rejected the module outright, unconditionally, before this walk runs.
            if (callee?.type !== 'MemberExpression')
                return;
            if (callee.object?.type !== 'Identifier' || callee.object.name !== 'supersurf')
                return;
            if (callee.computed) {
                error =
                    "supersurf[...](...): computed member access on the `supersurf` client object is not allowed — " +
                        'call verbs directly as `supersurf.click(...)`, never via bracket notation';
                return;
            }
            if (callee.property?.type !== 'Identifier')
                return;
            const method = callee.property.name;
            if (method === 'wait') {
                const arg = node.arguments[0];
                if (!arg)
                    return;
                if (arg.type === 'Literal' && typeof arg.value === 'number')
                    return; // a numeric wait is a delay, not a target
                const msg = checkTarget('wait', arg);
                if (msg)
                    error = msg;
                return;
            }
            if (method === 'drag') {
                const from = node.arguments[0];
                const to = node.arguments[1];
                if (from) {
                    const msg = checkTarget('drag', from);
                    if (msg) {
                        error = msg;
                        return;
                    }
                }
                if (to) {
                    const msg = checkTarget('drag', to);
                    if (msg)
                        error = msg;
                }
                return;
            }
            if (!TARGET_METHODS.has(method))
                return;
            const arg = node.arguments[0];
            if (!arg)
                return; // a missing argument is a different failure, not this check's job
            const msg = checkTarget(method, arg);
            if (msg)
                error = msg;
        },
    });
    return error ? { error } : {};
}
//# sourceMappingURL=element-targets.js.map