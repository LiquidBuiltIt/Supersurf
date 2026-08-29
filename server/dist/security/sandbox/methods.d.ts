/**
 * The playbook client surface — every method the `supersurf` object exposes and
 * the parameter names its arguments travel under.
 *
 * IMPORTANT: this module must have ZERO imports. It is loaded by the sandbox
 * child process, which must not pull the server (logger, config, transports,
 * anything under `tools/`) into its address space. Keep it pure data plus one
 * pure function.
 *
 * This table does NOT know which MCP tool a method reaches. Per spec Addendum
 * A, `onCommand(method, params)` forwards verbatim and the client-method →
 * MCP-tool mapping is a Plan 3 deliverable (`server/src/playbooks/command-map.ts`).
 * Do not add a `tool:` field here.
 *
 * Deliberately absent, per spec §7.7: `connect` / `disconnect` (the runner owns
 * them), every profile tool (capability escalation), and `playbook()` (nesting,
 * deferred to a later version).
 *
 * @module security/sandbox/methods
 */
/** One client method: the parameter names its arguments travel under. */
export interface MethodSpec {
    /** Declared parameter names, in call order, copied from spec §7.7. */
    params: string[];
    /** The `see*` methods resolve to a boolean rather than a data payload. */
    returnsBoolean?: boolean;
}
/**
 * Client path → method spec. Dotted keys become nested objects on the client
 * (`tabs.list` → `supersurf.tabs.list`).
 *
 * Namespaced passthroughs take a single `opts` object — spec §7.7: "the
 * signature is the underlying tool's rawResult parameter object, with the
 * action enum unpacked into a method name".
 */
export declare const METHODS: Record<string, MethodSpec>;
/** Client path → the permission that must appear in `meta.permissions` for the
 *  method to be BUILT. Absent permission means absent method — there is no
 *  runtime check to bypass. */
export declare const PERMISSION_GATED: Record<string, string>;
/**
 * Turn a call's positional arguments into the named `params` object that
 * crosses the pipe. An argument that is `undefined` produces an ABSENT KEY —
 * never `null`, never a placeholder. Extra arguments beyond the declared
 * parameter list are dropped.
 */
export declare function buildParams(spec: MethodSpec, args: unknown[]): Record<string, unknown>;
//# sourceMappingURL=methods.d.ts.map