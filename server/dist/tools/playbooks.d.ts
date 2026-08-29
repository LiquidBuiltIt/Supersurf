/**
 * The `playbooks` MCP tool — history, list, inspect, validate, run.
 *
 * There is deliberately no `create` and no write action. SuperSurf never
 * authors a playbook file; the agent writes `*.playbook.js` with its own
 * harness's file tools. `history` is the one survivor of the recording era:
 * it reads the in-memory action trail, never the disk, so a script author can
 * read back the selectors a working run actually used.
 *
 * The `security.playbook_eval` gate is CALLER-BASED and enforced here, on the
 * agent path only. `supersurf playbook run` calls `runPlaybook` directly and
 * ignores the leaf — the untrusted party is the agent, not the human at a
 * terminal who can read the file before running it.
 *
 * @module tools/playbooks
 */
import type { ToolContext } from './lib/types';
import { type RunOutcome } from '../playbooks/runner';
/** Seam for tests. Production passes nothing and gets the real runner. */
export interface PlaybookDeps {
    runPlaybook?: (opts: any) => Promise<RunOutcome>;
}
export declare function onPlaybooks(ctx: ToolContext, args: any, options: any, deps?: PlaybookDeps): Promise<any>;
/**
 * `list`, `inspect` and `validate` are registry reads — no browser, no
 * extension — so `backend.ts` calls them directly to bypass the passive gate.
 */
export declare function doList(args: any): any;
export declare function doInspect(args: any): any;
export declare function doValidate(args: any): any;
//# sourceMappingURL=playbooks.d.ts.map