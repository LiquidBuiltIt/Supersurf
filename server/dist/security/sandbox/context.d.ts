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
/** The context property the playbook's default export is assigned to. */
export declare const DEFAULT_EXPORT_KEY = "__pb_default";
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
export declare function stripModuleSyntax(source: string): string;
/**
 * Build the vm context a playbook runs in.
 *
 * @param globals - The only things the script can see: `supersurf`, `params`, `log`.
 * @returns A contextified null-prototype object. Read the default export back
 *          off it at `DEFAULT_EXPORT_KEY` after running the script — and read
 *          the RE-REALMED `supersurf` / `params` / `log` off it too if you need
 *          to pass them anywhere, never the values you passed in.
 */
export declare function createPlaybookContext(globals: Record<string, unknown>): vm.Context;
/**
 * Compile stripped playbook source into a runnable script.
 *
 * `importModuleDynamically` throws rather than resolving: without it Node
 * raises ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING anyway, but an explicit throw
 * says what happened. `filename` shows up in stack traces, which is why the
 * byte-preserving strip matters.
 */
export declare function compilePlaybook(source: string, filename: string): vm.Script;
//# sourceMappingURL=context.d.ts.map