export declare const SUPERSURF_SERVICE = "supersurf";
export interface CredentialEntry {
    name: string;
    domain?: string;
}
export interface KeychainBackend {
    add(name: string, value: string, domain?: string): Promise<void>;
    get(name: string): Promise<string | null>;
    list(): Promise<CredentialEntry[]>;
    remove(name: string): Promise<void>;
}
export declare class KeychainError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
export declare class KeychainNotAvailableError extends KeychainError {
    constructor(platform: string, hint: string);
}
//# sourceMappingURL=types.d.ts.map