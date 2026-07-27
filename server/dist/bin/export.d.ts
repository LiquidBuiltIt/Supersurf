#!/usr/bin/env node
/** Absolute path to the per-session log directory under ~/.supersurf. */
export declare function getSessionsDir(homedir?: string): string;
/**
 * Collect exactly the files /usage-data-audit consumes: the current
 * `metrics-*.ndjson` trail and the legacy `audit-*.ndjson` trail. Returns
 * sorted absolute paths; an empty array if the directory is missing/unreadable.
 */
export declare function findUsageLogs(sessionsDir: string): string[];
/** Filesystem-safe, timestamped archive name. */
export declare function buildOutputName(now: Date): string;
export interface ExportDeps {
    sessionsDir?: string;
    cwd?: string;
    now?: Date;
    zip?: (outPath: string, files: string[]) => void;
    stdout?: (msg: string) => void;
    stderr?: (msg: string) => void;
}
/**
 * `supersurf export` — bundle usage-metrics logs into a .zip in the caller's
 * cwd. Takes no flags; `argv` is accepted only for dispatcher-signature parity.
 * Returns a process exit code (0 = success, 1 = failure).
 */
export declare function runExportProgram(_argv: string[], deps?: ExportDeps): Promise<number>;
//# sourceMappingURL=export.d.ts.map