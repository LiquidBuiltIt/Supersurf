import type { DomainStore, FingerprintRecord } from './types';
/** Test-only override of the storage directory. Clears the memo. */
export declare function setBaseDirForTests(dir: string): void;
/**
 * Read a domain store, reusing the last parse when the file on disk is unchanged.
 *
 * CONTRACT: the returned object is the cached instance, not a copy. Treat it as
 * read-only — mutate a store only via `putRecord`, which saves and refreshes the
 * memo in the same breath. Mutating without saving poisons the cache.
 */
export declare function loadDomain(domain: string): DomainStore;
export declare function saveDomain(store: DomainStore): void;
/** Returns the live cached record (same read-only contract as `loadDomain`) — mutate
 *  only via `putRecord`, never in place, or the in-process memo goes stale. */
export declare function getRecord(domain: string, route: string, selector: string): FingerprintRecord | undefined;
/**
 * Read every domain store on disk. Uncached, unlike `loadDomain`: this exists
 * for `security/element-targets.ts`'s handle-existence scan, which is a
 * validate-time, on-disk check that runs far less often than the per-request
 * `loadDomain` path this file otherwise optimizes for, so a fresh directory
 * listing + parse on every call is the simpler correct choice over teaching
 * the mtime+size memo about a "read everything" mode.
 *
 * A corrupt or unparseable domain file is skipped rather than thrown — one
 * bad file must not fail validation of every other domain's handles.
 */
export declare function loadAllDomains(): DomainStore[];
export declare function putRecord(domain: string, route: string, selector: string, rec: FingerprintRecord): void;
//# sourceMappingURL=store.d.ts.map