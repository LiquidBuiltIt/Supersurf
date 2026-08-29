#!/usr/bin/env node
/**
 * `supersurf playbook` — discover, validate, run and migrate playbook scripts.
 *
 * `ls`/`inspect`/`validate` are daemon-free by design, modelled on `creds.ts`
 * rather than `profiles-cli.ts`: they must work with no daemon running and no
 * browser connected. There is no `create` and no `edit`: a playbook is a
 * JavaScript file, so it is written with an editor, removed with `rm`, and
 * copied with `cp`.
 *
 * `run` at a terminal IGNORES `security.playbook_eval`. That gate exists
 * because an agent is an untrusted caller; the human running this command can
 * read the file first, so gating them would be theatre.
 *
 * @module bin/playbook-cli
 */
import { Command } from 'commander';
import { type RunOutcome } from '../playbooks/runner';
import type { PlaybookMeta } from '../security/meta';
export interface RunOpts {
    log?: (msg: string) => void;
    errLog?: (msg: string) => void;
}
export interface RunRunOpts extends RunOpts {
    runPlaybook?: (opts: any) => Promise<RunOutcome>;
}
export declare function buildPlaybookProgram(): Command;
export declare function runLs(opts?: RunOpts): Promise<void>;
export declare function runInspect(name: string, opts?: RunOpts): Promise<number>;
export declare function runValidate(name: string | undefined, opts?: RunOpts): Promise<number>;
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
export declare function runPlaybookProgram(argv: string[]): Promise<void>;
//# sourceMappingURL=playbook-cli.d.ts.map