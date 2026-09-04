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
 * Caps on the child-controlled fields of `fail`, `log`, and `done` frames.
 *
 * EVERY field of every frame from the child is child-controlled and untrusted.
 * `wrap()` in `context.ts` rebuilds a thrown error as a bare vm-realm `Error`
 * carrying only `String(e.message)`, so nothing about a frame's shape is
 * verifiable from this side — a script can set `e.stack = 'Z'.repeat(2e6)`, or
 * call `log('Z'.repeat(2e6))`, or return a multi-megabyte object, and the host
 * has no way to tell any of that from a legitimate value.
 *
 * The caps belong HERE, at the pipe, and not at the places the values end up
 * (`runner.ts` → `runs.ts`, which persists them forever in the sidecar, and
 * `tools/playbooks.ts`, which pushes them straight into an agent-facing MCP
 * response). One boundary owning each field is how the NEXT field is kept from
 * leaking the same way. This is the same 766 KB bug the error taxonomy exists
 * to close, reached through different fields.
 *
 * What IS bounded here: `fail.message`, `fail.stack`, every `log.message`
 * (individually AND in aggregate across a run), `done.result` (by serialized
 * size, replaced with a visible truncation marker over the cap — never
 * silently dropped), every chunk the child writes to stderr (individually,
 * AND charged against the SAME aggregate budget `log.message` uses — stdout
 * logs and stderr are not two separate ceilings, they are one, so a script
 * cannot double the effective log budget by splitting output across both
 * channels), the stderr tail folded into the exit handler's
 * `HarnessUnavailable` message when the child dies without a `done`/`fail`
 * frame, and `at.method` — the copy of a `cmd` frame's method name this
 * module records against a classified command failure (see `handleCommand`
 * below).
 *
 * What is NOT bounded here: a `cmd` frame's `method`/`params` AS FORWARDED TO
 * `onCommand` — spec Addendum A requires that forward to be VERBATIM, so a
 * script can still send an arbitrarily large param (e.g.
 * `type(sel, 'A'.repeat(1e7))`) on its way to an MCP tool call. Bounding that
 * is downstream tool validation's job, not this pipe boundary's — this module
 * does not claim to own it. `at.method` above is a SEPARATE copy this module
 * keeps for its own failure record; capping that copy does not touch the
 * verbatim forward.
 *
 * A stack gets a few KB because the frames below the throw site are the useful
 * part. A message gets far less — it is one line in a rendered failure report.
 * A log line is prose, not a stack trace, so it gets a similar per-line budget
 * to a message, plus a total-run budget so a flood of short lines cannot add up
 * to the same blowout as one long one. A result is the whole point of running a
 * playbook, so its cap is generous — well above any reasonable return value,
 * well below a context blowout.
 */
export declare const MAX_FAIL_STACK_CHARS = 4000;
export declare const MAX_FAIL_MESSAGE_CHARS = 1000;
export declare const MAX_LOG_LINE_CHARS = 2000;
export declare const MAX_LOG_TOTAL_CHARS = 20000;
export declare const MAX_RESULT_CHARS = 100000;
export declare const MAX_RESULT_PREVIEW_CHARS = 2000;
/**
 * Bound on `at.method`, the copy of a `cmd` frame's method name this module
 * records against a classified command failure (`handleCommand` below). An
 * honest script can never reach this — the 52 declared `supersurf.*` methods
 * are all short names — only a compromised child forging a `cmd` frame can.
 * Small on purpose: it is a method name, not prose.
 */
export declare const MAX_COMMAND_METHOD_CHARS = 200;
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