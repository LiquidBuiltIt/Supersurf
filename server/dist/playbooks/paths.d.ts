/**
 * Where playbook scripts live and what they are called.
 *
 * The filename IS the address — `meta` carries no `name` field (spec §7.3).
 * `<name>.playbook.js` is the script; `<name>.runs.jsonl` is its append-only
 * run sidecar (spec §7.8), which is why the extension check below is
 * suffix-exact rather than a bare `.js` test.
 *
 * @module playbooks/paths
 */
export declare const PLAYBOOK_EXT = ".playbook.js";
export declare const RUNS_EXT = ".runs.jsonl";
/** Test-only override of the playbooks directory. */
export declare function setPlaybooksDirForTests(dir: string): void;
export declare function getPlaybooksDir(): string;
/**
 * Normalize a name to snake_case. Never rejects on shape — the repo rule is
 * normalize, don't fault. Path separators collapse into underscores, so a
 * name can never address a file outside the playbook directory.
 */
export declare function normalizeName(raw: string): string;
export declare function playbookFile(name: string): string;
export declare function runsFile(name: string): string;
/** Basename minus the playbook extension — the inverse of `playbookFile`. */
export declare function nameFromFile(file: string): string;
/** Absolute paths of every playbook script in the directory, sorted by name. */
export declare function listPlaybookFiles(): string[];
//# sourceMappingURL=paths.d.ts.map