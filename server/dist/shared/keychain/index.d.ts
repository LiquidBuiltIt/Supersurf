import type { KeychainBackend } from './types';
export type { KeychainBackend, CredentialEntry } from './types';
export { KeychainError, KeychainNotAvailableError, SUPERSURF_SERVICE } from './types';
export { InMemoryKeychainBackend } from './inmemory';
export { MacosKeychainBackend } from './macos';
export { LinuxKeychainBackend } from './linux';
export declare function getKeychainBackend(platform?: string): KeychainBackend;
//# sourceMappingURL=index.d.ts.map