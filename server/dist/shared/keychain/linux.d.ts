import type { KeychainBackend, CredentialEntry } from './types';
export declare class LinuxKeychainBackend implements KeychainBackend {
    add(name: string, value: string, domain?: string): Promise<void>;
    get(name: string): Promise<string | null>;
    list(): Promise<CredentialEntry[]>;
    remove(name: string): Promise<void>;
}
//# sourceMappingURL=linux.d.ts.map