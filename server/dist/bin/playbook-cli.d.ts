#!/usr/bin/env node
/**
 * `supersurf playbook` — manage saved playbooks.
 *
 * File management (`ls`/`show`/`edit`/`rm`/`export`/`import`) is daemon-free
 * by design, modelled on `creds.ts` rather than `profiles-cli.ts`: it must
 * work with no daemon running and no browser connected. Creation is
 * deliberately absent — playbooks are built from action ids that live in the
 * agent's context, not in the user's terminal.
 *
 * `run` is the one command that needs a live browser: it drives the same
 * `ConnectionManager` the MCP server and `--script-mode` use (see
 * `stdio.ts`), in-process, so there is exactly one playbook runner — the
 * `playbooks` MCP tool — regardless of caller.
 *
 * @module bin/playbook-cli
 */
import { Command } from 'commander';
/** Either a bare exit status (legacy shape), or a status/error pair mirroring `spawnSync`'s result. */
export type SpawnEditorResult = number | {
    status: number | null;
    error?: Error;
};
export interface RunOpts {
    log?: (msg: string) => void;
    spawnEditor?: (cmd: string, args: string[]) => SpawnEditorResult;
    isTTY?: boolean;
}
export declare function buildPlaybookProgram(): Command;
export declare function runLs(opts?: RunOpts): Promise<void>;
export declare function runShow(name: string, opts?: RunOpts): Promise<void>;
export declare function runEdit(name: string, flags: {
    drop?: string;
}, opts?: RunOpts): Promise<void>;
export declare function runRm(name: string, opts?: RunOpts): Promise<void>;
export declare function runExport(name: string, file: string, opts?: RunOpts): Promise<void>;
export declare function runImport(file: string, opts?: RunOpts): Promise<void>;
/** Minimal surface `run` needs from a live connection — mirrors `ConnectionManager.callTool`. */
export interface RunBackend {
    callTool(name: string, args: Record<string, unknown>, options: {
        rawResult?: boolean;
    }): Promise<any>;
}
export interface RunRunOpts {
    log?: (msg: string) => void;
    errLog?: (msg: string) => void;
    /** Test seam. Production builds a real `ConnectionManager` off resolved config. */
    createBackend?: () => RunBackend;
}
/**
 * Run a saved playbook end-to-end: connect, call the `playbooks` MCP tool with
 * `{action:'run', name}`, print its result, then disconnect. Always disconnects —
 * on a failed step, a connect failure, an unexpected error, or SIGINT — because a
 * left-open session pins the daemon (and, for a managed profile, the browser) alive.
 *
 * Returns the process exit code rather than throwing, so a reported failed step
 * (not a bug — a normal "the playbook broke on step 3" outcome) prints its own
 * trail instead of being flattened into the generic `[playbook] <message>` shape
 * `runPlaybookProgram`'s catch-all uses for actual exceptions.
 */
export declare function runRun(name: string, flags: {
    profile?: string;
    json?: boolean;
}, opts?: RunRunOpts): Promise<number>;
export declare function runPlaybookProgram(argv: string[]): Promise<void>;
//# sourceMappingURL=playbook-cli.d.ts.map