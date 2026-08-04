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
export declare function putRecord(domain: string, route: string, selector: string, rec: FingerprintRecord): void;
//# sourceMappingURL=store.d.ts.map