/**
 * One-shot JSON playbook -> `.playbook.js` converter.
 *
 * This is the LAST code that will ever read the JSON format; the reader is
 * deleted in the same release. It therefore carries its own local copy of the
 * legacy shape rather than importing from `playbooks/types.ts`, whose
 * `Playbook`/`PlaybookStep` are going away.
 *
 * A migrated script has NO params. That is correct, not a gap: a recording is
 * a fixed value, and parameterization is exactly the thing the JSON format
 * could not express. The output is a starting point a human edits.
 *
 * Anything that cannot be mapped is emitted as a `// TODO` line carrying the
 * original step verbatim. Guessing at a step would produce a script that runs
 * and does the wrong thing, which is strictly worse than one that does not
 * compile.
 *
 * @module playbooks/migrate
 */
/** The legacy on-disk shape. Copied here because its type module is going away. */
interface LegacyStep {
    tool: string;
    type: string;
    params: Record<string, any>;
    url?: string;
    sourceId: number;
}
interface LegacyPlaybook {
    name: string;
    purpose: string;
    steps: LegacyStep[];
    createdAt: number;
    version: number;
    profile?: string;
}
export interface RunOpts {
    log?: (msg: string) => void;
}
/** One legacy step -> one line of script. `manual` marks a step a human must finish. */
export declare function stepToSource(step: LegacyStep): {
    line: string;
    manual: boolean;
};
export declare function toScript(pb: LegacyPlaybook): string;
/** Convert every legacy JSON playbook in the directory. Returns an exit code. */
export declare function runMigrate(flags?: {
    dryRun?: boolean;
}, opts?: RunOpts): Promise<number>;
export {};
//# sourceMappingURL=migrate.d.ts.map