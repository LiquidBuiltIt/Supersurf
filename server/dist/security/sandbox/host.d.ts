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
import type { PlaybookErrorType } from '../../playbooks/errors';
/** Everything a run needs. */
export interface PlaybookRunOptions {
    file: string;
    params: Record<string, unknown>;
    meta: PlaybookMeta;
    /**
     * The sha256 the registry validated `file` against (`ValidationRecord.hash`).
     * `refreshRegistry()` gates its read on `mtime`+`size`, NOT content — two
     * writes that land on the same size at the same explicit mtime (e.g. a
     * fixed-width payload swap) skip the read entirely, and the cached record
     * keeps saying `valid: true` for bytes nobody has looked at. The registry
     * is the LISTING path; this is the EXECUTION path, and it must not inherit
     * that shortcut. The host re-hashes the bytes it is about to run and
     * refuses unless they equal this value — see the check in
     * `runPlaybookScript`. A timestamp is never the sole basis for a security
     * decision.
     */
    hash: string;
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
    /**
     * Which KIND of failure. Absent only on success. The runner writes this onto
     * the run record, and it is what decides whether the failure is worth reading
     * the page for — see `playbooks/errors.ts`.
     */
    type?: PlaybookErrorType;
    /** Type-specific detail: `{ selector }`, `{ requestedUrl }`, `{ reason }`. */
    payload?: Record<string, unknown>;
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
 * Refuse the run when the resolved child entry is the tsx/`child.ts` fallback,
 * unless the caller has explicitly opted out of sandboxing.
 *
 * `permissionFlagsFor` already returns `[]` for a `.ts` entry — tsx's loader
 * needs filesystem and module-resolution access the Node permission model
 * would deny — so an unbuilt source checkout spawns the untrusted playbook
 * with the process cage OFF: no `--allow-fs-read` scoping, unrestricted
 * filesystem read. A published install and any BUILT checkout never reach
 * this path; only a checkout that skipped `npm run build` does, but nothing
 * stops that checkout from also being a CI runner or a shared host, so the
 * relaxation must be a loud, explicit choice, not a silent fallback.
 *
 * `SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK=1` is that explicit choice. Set it and
 * the run proceeds, but `onLog` gets a warning naming exactly what protection
 * is off — a silent downgrade of a security guarantee is worse than a loud one.
 *
 * @returns an error string to abort the run with, or `null` to proceed.
 */
export declare function checkChildEntrySandboxing(entry: string, onLog: (message: string) => void): string | null;
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