/**
 * `supersurf playbook run` — the terminal-side run entrypoint, server half.
 *
 * `ls`, `inspect`, `validate` and `migrate` live in the compiled `supersurf`
 * binary (`cli/`) and stay there: they are daemon-free and dependency-light.
 * `run` cannot follow them. It reaches `playbooks/runner.ts` and therefore the
 * ConnectionManager, the daemon and `tools/` — including `tools/screenshot.ts`,
 * the tree's only `sharp` importer. Compiling that into the binary would
 * reinstate the per-platform native-addon build matrix the extraction removed.
 * So the binary shells out to `npx supersurf-mcp@<version> playbook run …`, and
 * this module is what receives that argv.
 *
 * `run` at a terminal IGNORES `security.playbook_eval`. That gate exists
 * because an agent is an untrusted caller; the human running this command can
 * read the file first, so gating them would be theatre. It is enforced in
 * `tools/playbooks.ts`, on the agent path, and deliberately nowhere else.
 *
 * The caller runs the same name/validity/param pre-flight before it shells out,
 * so a typo fails without paying an npx cold start. That is the caller's
 * convenience, not this module's guarantee — the server validates its own
 * input rather than trusting an argv it did not build.
 *
 * @module playbooks/run-cli
 */
import { type RunOutcome } from './runner';
import type { PlaybookMeta } from '../security/meta';
export interface RunOpts {
    log?: (msg: string) => void;
    errLog?: (msg: string) => void;
}
export interface RunRunOpts extends RunOpts {
    runPlaybook?: (opts: any) => Promise<RunOutcome>;
}
/**
 * Turn repeated `--param key=value` flags into a params object, coercing to
 * the type `meta` declares. An undeclared key stays a string on purpose:
 * `validateParams` rejects it by name, which is a better error than a coercion
 * failure on a param that does not exist.
 */
export declare function parseParamFlags(pairs: string[], meta: PlaybookMeta): {
    params?: Record<string, unknown>;
    error?: string;
};
export declare function runRun(name: string, flags: {
    param?: string[];
    profile?: string;
    json?: boolean;
}, opts?: RunRunOpts): Promise<number>;
//# sourceMappingURL=run-cli.d.ts.map