/**
 * The parent side of the playbook sandbox.
 *
 * Reads the file (the child never touches disk), validates the caller's params
 * against `meta.params`, spawns the locked-down child, and pumps the NDJSON
 * pipe until the script finishes, fails, or runs out of time.
 *
 * `onCommand` is forwarded VERBATIM (spec Addendum A): this module holds no
 * ConnectionManager and does no client-method → MCP-tool translation. That map
 * is a Plan 3 deliverable.
 *
 * Lockdown is `spawn`, not `fork`: `fork` opens an IPC channel and gives the
 * child `process.send`, a live handle back into the parent. The child gets
 * pipe-only stdio, `env: {}`, and a throwaway cwd.
 *
 * HONEST SCOPE: Node's permission model has no network flag. "No network" in
 * the child is enforced by omission inside the vm (no fetch, no http, no
 * require) — NOT by the kernel. The kernel-enforced part is process isolation
 * plus, on Node 20+, the filesystem permission flags below.
 *
 * @module security/sandbox/host
 */
import type { PlaybookMeta } from '../meta';
/** Everything a run needs. */
export interface PlaybookRunOptions {
    file: string;
    params: Record<string, unknown>;
    meta: PlaybookMeta;
    /** Invoked for every command the script sends. The host validates and
     *  forwards to the browser. Rejects → the script's call throws. */
    onCommand: (method: string, params: any) => Promise<any>;
    onLog: (message: string) => void;
    timeoutMs?: number;
}
/** The outcome of one run. */
export interface PlaybookRunResult {
    ok: boolean;
    result?: unknown;
    error?: string;
    stack?: string;
    durationMs: number;
}
/**
 * Check the caller's arguments against `meta.params`.
 * @returns null when valid, otherwise a human-facing reason.
 */
export declare function validateParams(params: Record<string, unknown>, meta: PlaybookMeta): string | null;
/**
 * Node permission-model flags for the child.
 *
 * Read access is scoped to the code the child must load: the package that owns
 * the entry plus the hoisted `node_modules` above it (see `readRootsFor`).
 * **Write is never granted at all.** There is no network flag in Node's
 * permission model — do not pretend otherwise.
 *
 * The unbuilt-checkout fallback runs the TypeScript entry through tsx, which
 * needs loader and filesystem access the permission model denies, so it gets no
 * flags. That relaxation never reaches users: a published install, and any
 * built checkout, runs the compiled `child.js` with the flags on.
 */
export declare function permissionFlagsFor(nodeVersion: string, entry: string): string[];
/**
 * Locate the child entry.
 *
 * The COMPILED child wins wherever it exists — published install or built
 * source checkout — and runs under plain `node`. That keeps a TypeScript loader
 * out of the process that executes untrusted playbook code, and it keeps a
 * clean install working, because tsx never ships to users.
 *
 * tsx + `child.ts` is the fallback for an UNBUILT source checkout only.
 */
export declare function resolveChildEntry(): {
    command: string;
    argv: string[];
    entry: string;
};
/** Run one playbook file to completion. Never throws — every outcome is a result. */
export declare function runPlaybookScript(opts: PlaybookRunOptions): Promise<PlaybookRunResult>;
//# sourceMappingURL=host.d.ts.map