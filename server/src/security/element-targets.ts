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

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { METHODS } from './sandbox/methods';
import type { PlaybookMeta } from './meta';
import { isHandleRef } from '../experimental/fingerprinting/handle-resolve';
import { normalizeName } from '../experimental/fingerprinting/naming';
import { loadDomain, loadAllDomains } from '../experimental/fingerprinting/store';
import type { DomainStore } from '../experimental/fingerprinting/types';

/**
 * `supersurf.<method>` calls whose first positional argument is an element
 * target — derived from `METHODS` itself (single source of truth) rather than
 * a hand-maintained duplicate list, so a future verb whose first param is
 * named `selector` is picked up automatically. Namespaced passthroughs
 * (`tabs.list`, …) never have a `selector` first param, so the `.` filter
 * only excludes paths that could never match anyway.
 *
 * `wait(msOrSelector)` and `drag(from, to)` are deliberately NOT included:
 * `msOrSelector` is a union (number delay vs. string selector) that cannot be
 * told apart from syntax alone, and `drag`'s two target params aren't named
 * `selector`. Both are a known gap, not an oversight — see the task report.
 */
const TARGET_METHODS = new Set(
  Object.entries(METHODS)
    .filter(([path, spec]) => !path.includes('.') && spec.params[0] === 'selector')
    .map(([path]) => path)
);

/** One resolved (or rejected) element-target argument. */
interface TargetResolution {
  value?: string;
  /** Present iff the argument's FORM is illegal. Names the offending form. */
  formError?: string;
}

/**
 * Resolve a call argument to its element-target string, or reject its FORM.
 * The only resolution performed is constant-folding a `const`-bound
 * identifier to the string literal it was declared with — nothing else is
 * ever evaluated, matching `meta.ts`'s "parsed, never executed" posture.
 */
function resolveTarget(node: any, constStrings: Map<string, string>): TargetResolution {
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') return { value: node.value };
      return { formError: `is a ${typeof node.value} literal — an element target must be a string` };

    case 'Identifier': {
      const bound = constStrings.get(node.name);
      if (bound !== undefined) return { value: bound };
      return {
        formError:
          `is the identifier \`${node.name}\`, which is not \`const\`-bound to a string literal in this module ` +
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
function storeHasHandle(store: DomainStore, normalized: string): boolean {
  for (const byRoute of Object.values(store.routes)) {
    for (const rec of Object.values(byRoute)) {
      if (rec.handleName === normalized) return true;
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
function handleIsRecorded(normalized: string, startingPoint: string | undefined): boolean {
  if (!normalized) return false;

  // Mirrors `playbooks/report.ts`'s `startPoint()` normalization so a
  // `meta.startingPoint` of 'X.com' or 'www.x.com' still hits the same file
  // `domainOf()` would have written the fingerprints under.
  const hintDomain = typeof startingPoint === 'string' && startingPoint.trim()
    ? startingPoint.trim().toLowerCase().replace(/^www\./, '')
    : null;

  if (hintDomain && storeHasHandle(loadDomain(hintDomain), normalized)) return true;

  for (const store of loadAllDomains()) {
    if (hintDomain && store.domain === hintDomain) continue; // already checked above
    if (storeHasHandle(store, normalized)) return true;
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
export function validateElementTargets(source: string, meta: PlaybookMeta): { error?: string } {
  let ast: any;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return {};
  }

  // Collect every `const <id> = '<literal>'` binding in the module — the
  // ONLY resolution step this check performs (constant-folding). Not
  // scope-aware: a name that is const-bound to a string literal ANYWHERE in
  // the module resolves, first declaration wins on a rare same-name shadow.
  const constStrings = new Map<string, string>();
  walk.simple(ast, {
    VariableDeclaration(node: any) {
      if (node.kind !== 'const') return;
      for (const d of node.declarations) {
        if (d.id?.type === 'Identifier' && d.init?.type === 'Literal' && typeof d.init.value === 'string') {
          if (!constStrings.has(d.id.name)) constStrings.set(d.id.name, d.init.value);
        }
      }
    },
  });

  let error: string | null = null;

  walk.simple(ast, {
    CallExpression(node: any) {
      if (error) return;

      const callee = node.callee;
      if (callee?.type !== 'MemberExpression' || callee.computed) return;
      if (callee.object?.type !== 'Identifier' || callee.object.name !== 'supersurf') return;
      if (callee.property?.type !== 'Identifier') return;

      const method = callee.property.name;
      if (!TARGET_METHODS.has(method)) return;

      const arg = node.arguments[0];
      if (!arg) return; // a missing argument is a different failure, not this check's job

      const resolved = resolveTarget(arg, constStrings);
      if (resolved.formError) {
        error = `supersurf.${method}(...): element target ${resolved.formError}`;
        return;
      }

      const raw = resolved.value!;
      if (isHandleRef(raw)) {
        const normalized = normalizeName(raw.slice(1));
        if (!handleIsRecorded(normalized, meta.startingPoint)) {
          error =
            `supersurf.${method}('${raw}'): no recorded handle named "${normalized}" in ` +
            `~/.supersurf/fingerprints/ — drive the task live first so the element is captured ` +
            `under this name, or check the spelling`;
        }
      } else if (!meta.useRawSelectors) {
        error =
          `supersurf.${method}('${raw}'): raw CSS selectors are not allowed — element targets must ` +
          `be handles (\`@name\`) unless meta.useRawSelectors is true (a permission gate that ` +
          `ADDITIONALLY allows raw selectors; it does not turn off the handle check)`;
      }
    },
  });

  return error ? { error } : {};
}
