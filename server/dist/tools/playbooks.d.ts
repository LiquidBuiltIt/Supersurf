/**
 * The `playbooks` MCP tool — history, create, run.
 *
 * NOT an experiment. This is core infrastructure that CHECKS the `fingerprinting`
 * experiment: `create` and `run` refuse without it, because a saved playbook whose
 * selectors cannot heal is a brittle macro, not a playbook. `history` works
 * regardless — it only reports what already happened.
 *
 * @module tools/playbooks
 */
import type { ToolContext } from './lib/types';
/** Seams for tests. Production passes nothing and gets the real implementations. */
export interface PlaybookDeps {
    executeAction?: (ctx: ToolContext, action: any) => Promise<string>;
    navigate?: (ctx: ToolContext, args: any, options: any) => Promise<any>;
    callHandler?: (ctx: ToolContext, name: string, args: Record<string, unknown>, options: {
        rawResult?: boolean;
    }) => Promise<any | null>;
}
/**
 * Resolve which profile a `run` call should target: the explicit `profile`
 * arg wins, else the playbook's own `profile` field (set by `create` when the
 * recording session was profile-bound), else `undefined` (no profile).
 *
 * Exported so `backend/handlers.ts` can resolve the target profile BEFORE a
 * bridge exists — passive-state `run` needs the answer to pick a profile for
 * its implicit `connect`, and active-state `run` needs it to check for a
 * mismatch against the session's already-bound profile.
 */
export declare function resolveRunProfile(args: any): string | undefined;
export declare function onPlaybooks(ctx: ToolContext, args: any, options: any, deps?: PlaybookDeps): Promise<any>;
//# sourceMappingURL=playbooks.d.ts.map