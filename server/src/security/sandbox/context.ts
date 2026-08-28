/**
 * The playbook vm context — Layer 2 of three.
 *
 * `node:vm` is explicitly NOT a security boundary (nodejs.org/api/vm.html). It
 * is defense in depth. The only kernel-enforced boundary is the child process
 * that owns this context. `vm2`, which did claim to be a boundary, took
 * critical sandbox-escape CVEs and was deprecated in 2023 — do not reach for a
 * userland "secure vm" library to make this stronger.
 *
 * Two rules hold this file together:
 *
 * 1. **`codeGeneration: { strings: false, wasm: false }` is the linchpin.**
 *    Without it, `supersurf.click.constructor('return process')()` returns the
 *    HOST `Function` and the vm is escaped in one line.
 * 2. **Node globals are absent by OMISSION, never deleted.** The context object
 *    is `Object.create(null)`; it never had `require`, `process`, `Buffer`,
 *    `console` or the timers. Building a real global and deleting keys off it
 *    is one missed key away from a full escape.
 *
 * Timers are deliberately absent — a playbook waits with `supersurf.wait(ms)`.
 *
 * ESM handling: playbook files are modules (`export const meta`,
 * `export default`), and `vm.Script` only runs scripts. Rather than
 * `vm.SourceTextModule` (needs `--experimental-vm-modules`, API has churned),
 * the module syntax is rewritten in place **without moving a single byte**, so
 * every line and column in a stack trace still points at the author's source.
 *
 * @module security/sandbox/context
 */

import vm from 'vm';
import * as acorn from 'acorn';

/** The context property the playbook's default export is assigned to. */
export const DEFAULT_EXPORT_KEY = '__pb_default';

/** Replace every character with a space, keeping newlines so line numbers hold. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Remove ESM syntax from playbook source, preserving the exact byte length.
 *
 * - `export default <expr>` → `__pb_default = <expr>` padded to the same width
 * - `export const meta = …` → the `export` keyword becomes spaces
 * - `export { a }` / `import …` → the whole statement becomes spaces
 *
 * Unparseable source is returned unchanged; the caller compiles it and lets
 * the real syntax error surface with correct positions.
 */
export function stripModuleSyntax(source: string): string {
  let ast: any;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return source;
  }

  const out = source.split('');
  const splice = (start: number, end: number, replacement: string) => {
    for (let i = start; i < end; i++) out[i] = '';
    out[start] = replacement;
  };

  for (const node of ast.body) {
    if (node.type === 'ExportDefaultDeclaration') {
      const span = source.slice(node.start, node.declaration.start);
      const assign = `${DEFAULT_EXPORT_KEY} =`;
      // 'export default ' is 15 chars; the assignment is 14. Any extra
      // whitespace between the keywords only widens the pad.
      splice(node.start, node.declaration.start, assign + ' '.repeat(span.length - assign.length));
    } else if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      splice(node.start, node.declaration.start, blank(source.slice(node.start, node.declaration.start)));
    } else if (
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ImportDeclaration'
    ) {
      splice(node.start, node.end, blank(source.slice(node.start, node.end)));
    }
  }

  return out.join('');
}

/**
 * Build the vm context a playbook runs in.
 *
 * @param globals - The only things the script can see: `supersurf`, `params`, `log`.
 * @returns A contextified null-prototype object. Read the default export back
 *          off it at `DEFAULT_EXPORT_KEY` after running the script.
 */
export function createPlaybookContext(globals: Record<string, unknown>): vm.Context {
  // Null prototype: `globalThis.constructor` is undefined, so the global itself
  // is not a rung on a ladder back to the host realm.
  const sandbox: Record<string, unknown> = Object.create(null);
  // Seeded so `'use strict'` playbooks can assign the default export without
  // a ReferenceError on an undeclared global.
  sandbox[DEFAULT_EXPORT_KEY] = undefined;
  // `console` is the ONE global Node installs into every context on its own, so
  // omission cannot remove it — it is shadowed instead. This is not cosmetic:
  // in the child process stdout IS the NDJSON pipe, and a playbook calling
  // `console.log` would write a non-frame line into the protocol stream.
  sandbox.console = undefined;
  for (const [key, value] of Object.entries(globals)) {
    sandbox[key] = value;
  }

  const context = vm.createContext(sandbox, {
    name: 'supersurf-playbook',
    codeGeneration: { strings: false, wasm: false },
  });

  // `Object.create(null)` gives the SANDBOX a null prototype, not the
  // contextified global V8 builds around it — that one still inherits the new
  // realm's `Object.prototype`, so `globalThis.constructor` is a live function.
  // Cut it here so the global is not a rung on any ladder. Compiling from the
  // host is unaffected by `codeGeneration.strings: false`, which only governs
  // code generated from INSIDE the context.
  new vm.Script('Object.setPrototypeOf(globalThis, null);').runInContext(context);

  return context;
}

/**
 * Compile stripped playbook source into a runnable script.
 *
 * `importModuleDynamically` throws rather than resolving: without it Node
 * raises ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING anyway, but an explicit throw
 * says what happened. `filename` shows up in stack traces, which is why the
 * byte-preserving strip matters.
 */
export function compilePlaybook(source: string, filename: string): vm.Script {
  return new vm.Script(stripModuleSyntax(source), {
    filename,
    importModuleDynamically: () => {
      throw new Error('import() is not available inside a playbook');
    },
  } as vm.ScriptOptions);
}
