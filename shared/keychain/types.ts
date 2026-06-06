export const SUPERSURF_SERVICE = 'supersurf';

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

export class KeychainError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'KeychainError';
  }
}

export class KeychainNotAvailableError extends KeychainError {
  constructor(platform: string, hint: string) {
    super(`Keychain not available on ${platform}. ${hint}`);
    this.name = 'KeychainNotAvailableError';
  }
}
