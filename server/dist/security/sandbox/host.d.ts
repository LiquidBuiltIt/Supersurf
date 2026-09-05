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
 * Caps on the child-controlled fields crossing the sandbox pipe.
 *
 * THE INVARIANT: every field of every frame from the child is child-controlled
 * and untrusted, and nothing crosses this boundary unbounded. `wrap()` in
 * `context.ts` rebuilds a thrown error as a bare vm-realm `Error` carrying only
 * `String(e.message)`, so nothing about a frame's shape is verifiable from
 * this side — a script can set `e.stack = 'Z'.repeat(2e6)`, or call
 * `log('Z'.repeat(2e6))`, or return a multi-megabyte object, or hold a stdout
 * line open with no newline for the run's whole timeout, and the host has no
 * way to tell any of that from a legitimate value.
 *
 * The caps belong HERE, at the pipe, and not at the places the values end up
 * (`runner.ts` → `runs.ts`, which persists them forever in the sidecar, and
 * `tools/playbooks.ts`, which pushes them straight into an agent-facing MCP
 * response). One boundary owning every field is how a field this comment does
 * not name stays covered anyway: this inventory has been wrong once per fix
 * round, because a per-field list is a promise to keep updating it and a
 * comment that lists fields is a comment that goes stale. State the rule, not
 * the roster.
 *
 * THE TWO DELIBERATE EXCEPTIONS: a `cmd` frame's `method` and `params`, AS
 * FORWARDED TO `onCommand`. Spec Addendum A requires that forward to be
 * VERBATIM — this module holds no ConnectionManager and does no client-method
 * → MCP-tool translation, so this pipe boundary itself imposes no per-field
 * cap on `method`/`params` before the forward. They are NOT unbounded,
 * though: the whole frame still has to survive as one line within
 * `MAX_STDOUT_LINE_CHARS` to reach this module at all, so the real ceiling on
 * a verbatim forward is that line cap, enforced below, not a per-field one.
 * Bounding the field itself is downstream tool validation's job, not this
 * pipe boundary's. Every OTHER copy this module keeps for its own bookkeeping
 * — e.g. `at.method` on a classified command failure — is a separate value
 * and stays capped; only the verbatim forward itself is exempt.
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
 * Ceiling on the accumulating stdout line buffer (`buffer` in
 * `runPlaybookScript`). Only PARSED frames escape this module, and every
 * frame field above is capped — but the buffer itself, the raw bytes waiting
 * for a `\n` to complete a line, is not a frame yet, and a child that writes
 * newline-free bytes for the whole run timeout grows it without limit. Set
 * comfortably above `MAX_RESULT_CHARS` (2x) so a legitimate maximum-size
 * result frame, plus its JSON envelope, can never trip it — only a genuine
 * protocol violation (a line that was never going to terminate) does.
 *
 * The check against this constant runs AFTER each stdout chunk is appended
 * to `buffer`, not mid-chunk, so the actual ceiling is approximate: this
 * value plus at most one pipe chunk's worth of bytes can accumulate before
 * the check fires. Bounded, not exact — do not treat it as a precise limit.
 */
export declare const MAX_STDOUT_LINE_CHARS: number;
/**
 * Ceiling on the exit handler's stderr tail ring (see `stderrTail` in
 * `runPlaybookScript`). Deliberately a little UNDER `MAX_FAIL_MESSAGE_CHARS`,
 * not equal to it: the exit handler turns the ring's newlines into `' | '`
 * before its own final `capText` call, and `capText` cuts from the FRONT,
 * keeping the OLDEST bytes — the opposite of what the ring exists for. This
 * margin is sized so that substitution can never push the assembled tail past
 * `MAX_FAIL_MESSAGE_CHARS`, so that final cut never actually fires and never
 * has the chance to discard the newest bytes the ring just fought to keep.
 */
export declare const MAX_STDERR_TAIL_RING_CHARS: number;
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