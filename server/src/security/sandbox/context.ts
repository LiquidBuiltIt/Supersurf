/**
 * The playbook vm context — Layer 2 of three.
 *
 * `node:vm` is explicitly NOT a security boundary (nodejs.org/api/vm.html). It
 * is defense in depth. The only kernel-enforced boundary is the child process
 * that owns this context. `vm2`, which did claim to be a boundary, took
 * critical sandbox-escape CVEs and was deprecated in 2023 — do not reach for a
 * userland "secure vm" library to make this stronger.
 *
 * Three rules hold this file together:
 *
 * 1. **`codeGeneration: { strings: false, wasm: false }` is the linchpin.**
 *    Without it, `supersurf.click.constructor('return process')()` returns the
 *    HOST `Function` and the vm is escaped in one line.
 * 2. **Node globals are absent by OMISSION, never deleted.** The context object
 *    is `Object.create(null)`; it never had `require`, `process`, `Buffer`,
 *    `console` or the timers. Building a real global and deleting keys off it
 *    is one missed key away from a full escape.
 * 3. **Injected globals are RE-REALMED, never handed over as host values.**
 *    Rule 1 is scoped to this context only. A host function keeps its
 *    host-realm `.constructor`, and that constructor compiles in the HOST
 *    realm where codegen is allowed — so injecting `supersurf` directly made
 *    `supersurf.click.constructor('return this')()` hand back the host global
 *    in one line, flag or no flag. Every injected value is therefore rebuilt
 *    inside the vm realm (functions wrapped, data JSON round-tripped, errors
 *    rethrown as vm `Error`s) before any playbook code runs. Four one-hop
 *    ladders exist off a single host method and all four are closed here: the
 *    function, the promise it returns, the value that promise resolves to, and
 *    the error it throws. Anything new put on the context goes through
 *    `rebuild` too — do NOT add a raw host value to the sandbox.
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
 * The single temporary key the host values arrive on. The bootstrap reads it,
 * rebuilds vm-realm equivalents onto `globalThis`, and deletes it — a playbook
 * never sees this property.
 */
const HANDOFF_KEY = '__pb_host_handoff';

/**
 * Rebuild every injected host value inside the vm realm. Host-compiled, so
 * `codeGeneration.strings: false` does not apply to it — that flag only governs
 * code generated from INSIDE the context, which is exactly why the escape it is
 * supposed to stop worked in the first place.
 *
 * `rebuild` walks the client recursively because `supersurf` is nested
 * (`{ tabs: { new: fn }, … }`). It only ever copies what it finds: a method
 * `buildClient` declined to create stays absent, so permission-by-construction
 * survives the rebuild untouched.
 *
 * Each wrapper is a vm-realm ASYNC ARROW, which matters four times over:
 *   - the wrapper's own `.constructor` is the vm's `AsyncFunction`
 *   - the promise it returns is a vm `Promise`, not the host's
 *   - `copy` re-realms the resolved value, which arrived over the NDJSON pipe
 *     and was `JSON.parse`d by the host (so it is JSON-serializable by
 *     construction — the round trip cannot lose anything a pipe kept)
 *   - a host `Error` from the `{ success: false }` envelope is rethrown as a vm
 *     `Error` carrying the same message
 *
 * The host call happens BEFORE the first `await`, i.e. synchronously on call —
 * playbooks write `log('x')` without awaiting and expect it to fire.
 */
const BOOTSTRAP = `(function () {
  var host = globalThis.${HANDOFF_KEY};
  delete globalThis.${HANDOFF_KEY};

  function copy(v) {
    if (v === null || typeof v !== 'object') return v;
    return JSON.parse(JSON.stringify(v));
  }

  function wrap(fn) {
    return async (...args) => {
      try {
        return copy(await fn(...args));
      } catch (e) {
        throw new Error(e && e.message !== undefined ? String(e.message) : String(e));
      }
    };
  }

  function rebuild(v) {
    if (v === null) return v;
    var t = typeof v;
    if (t === 'function') return wrap(v);
    if (t !== 'object') return v;
    if (Array.isArray(v)) {
      var arr = [];
      for (var i = 0; i < v.length; i++) arr[i] = rebuild(v[i]);
      return arr;
    }
    var obj = {};
    var keys = Object.keys(v);
    for (var j = 0; j < keys.length; j++) obj[keys[j]] = rebuild(v[keys[j]]);
    return obj;
  }

  var names = Object.keys(host);
  for (var k = 0; k < names.length; k++) globalThis[names[k]] = rebuild(host[names[k]]);
})();`;

/**
 * Build the vm context a playbook runs in.
 *
 * @param globals - The only things the script can see: `supersurf`, `params`, `log`.
 * @returns A contextified null-prototype object. Read the default export back
 *          off it at `DEFAULT_EXPORT_KEY` after running the script — and read
 *          the RE-REALMED `supersurf` / `params` / `log` off it too if you need
 *          to pass them anywhere, never the values you passed in.
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
  // Rule 3: the host values land on ONE temporary key, not on the globals the
  // playbook reads. The bootstrap below replaces them with vm-realm rebuilds.
  sandbox[HANDOFF_KEY] = { ...globals };

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
  // `vm.createContext` keeps the sandbox object in sync with the vm global in
  // BOTH directions, so the rebuilt globals — and the deleted handoff key —
  // show up on the object this function returns.
  new vm.Script(BOOTSTRAP).runInContext(context);

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
