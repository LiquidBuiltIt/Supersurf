import type { DomainStore, FingerprintRecord } from './types';
/** Test-only override of the storage directory. */
export declare function setBaseDirForTests(dir: string): void;
export declare function loadDomain(domain: string): DomainStore;
export declare function saveDomain(store: DomainStore): void;
export declare function getRecord(domain: string, route: string, selector: string): FingerprintRecord | undefined;
export declare function putRecord(domain: string, route: string, selector: string, rec: FingerprintRecord): void;
//# sourceMappingURL=store.d.ts.map