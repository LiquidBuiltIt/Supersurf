/**
 * The playbook validation cache.
 *
 * Validation is stat-on-tool-call (spec §4): `refreshRegistry()` runs once at
 * the top of `ConnectionManager.callTool()`, and the verdict rides that tool's
 * result. Two gates keep the cost near zero on the common path —
 *
 *   1. `stat` (mtime + size) decides whether to read the file at all;
 *   2. the sha256 content hash decides whether to re-validate.
 *
 * So `touch` costs a stat, and an editor that rewrites identical bytes costs a
 * read. Only genuinely different content pays for a parse.
 *
 * Reads are SYNCHRONOUS on purpose: `statusHeader()` is sync and must be able
 * to see the registry without awaiting anything.
 *
 * @module playbooks/registry
 */
import { type ValidationRecord } from '../security/validate';
/** Test seam. Pass `null` to restore the real validator. */
export declare function setValidatorForTests(fn: ((p: string) => Promise<ValidationRecord>) | null): void;
export declare function resetRegistryForTests(): void;
/**
 * Re-sync the cache with the playbooks directory. Never throws — a broken
 * file becomes an invalid record, which is exactly what the agent should be
 * told about, rather than an exception that takes down an unrelated tool call.
 */
export declare function refreshRegistry(): Promise<void>;
/** Every known playbook, valid or not, sorted by name. */
export declare function getRecords(): ValidationRecord[];
export declare function getRecord(name: string): ValidationRecord | undefined;
export declare function getInvalidRecords(): ValidationRecord[];
//# sourceMappingURL=registry.d.ts.map