export { FileLogger, LOG_ROOT, sanitizeFilename, truncateString, replacer } from './logger/logger';
export type { DebugMode } from './logger/logger';

export {
  ConfigService,
  HARDCODED_DEFAULTS,
  SCAFFOLD_DEFAULTS,
  loadJsonConfig,
  loadEnvConfig,
  ensureConfigFile,
} from './config/index';
export type {
  Config,
  PartialConfig,
  ConfigSource,
  ConfigInputs,
  LoadResult,
  ScaffoldResult,
} from './config/index';

export {
  getKeychainBackend,
  InMemoryKeychainBackend,
  MacosKeychainBackend,
  LinuxKeychainBackend,
  KeychainError,
  KeychainNotAvailableError,
  SUPERSURF_SERVICE,
} from './keychain/index';
export type { KeychainBackend, CredentialEntry } from './keychain/index';
