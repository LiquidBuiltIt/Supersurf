import type { KeychainBackend, CredentialEntry } from './types';
export declare class InMemoryKeychainBackend implements KeychainBackend {
    private store;
    add(name: string, value: string, domain?: string): Promise<void>;
    get(name: string): Promise<string | null>;
    list(): Promise<CredentialEntry[]>;
    remove(name: string): Promise<void>;
}
//# sourceMappingURL=inmemory.d.ts.map