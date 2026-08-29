/**
 * The playbook sandbox child process — Layer 3, the only kernel-enforced boundary.
 *
 * Layers 1 (static analysis) and 2 (the vm context) are filters; `node:vm` is
 * explicitly NOT a security boundary per Node's own docs. This process is.
 * It is spawned with no environment, a throwaway cwd, and pipe-only stdio.
 *
 * The child NEVER reads from disk. Source arrives in the `init` frame so the
 * server remains the single control point and authorizes before sending
 * anything. There is no `fs` import in this file, and there must never be one.
 *
 * stdout is the protocol pipe: nothing but NDJSON frames may be written to it.
 * Diagnostics go to stderr, which the host forwards to `onLog`.
 *
 * @module security/sandbox/child
 */
export {};
//# sourceMappingURL=child.d.ts.map