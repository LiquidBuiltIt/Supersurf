import type { KeychainBackend } from './types';
import { KeychainNotAvailableError } from './types';
import { MacosKeychainBackend } from './macos';
import { LinuxKeychainBackend } from './linux';

export type { KeychainBackend, CredentialEntry } from './types';
export { KeychainError, KeychainNotAvailableError, SUPERSURF_SERVICE } from './types';
export { InMemoryKeychainBackend } from './inmemory';
export { MacosKeychainBackend } from './macos';
export { LinuxKeychainBackend } from './linux';

export function getKeychainBackend(platform: string = process.platform): KeychainBackend {
  if (platform === 'darwin') return new MacosKeychainBackend();
  if (platform === 'linux') return new LinuxKeychainBackend();
  throw new KeychainNotAvailableError(
    platform,
    'SuperSurf credentials require macOS or Linux. Use env vars as a fallback.',
  );
}
