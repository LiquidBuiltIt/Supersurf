"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeychainNotAvailableError = exports.KeychainError = exports.SUPERSURF_SERVICE = void 0;
exports.SUPERSURF_SERVICE = 'supersurf';
class KeychainError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'KeychainError';
    }
}
exports.KeychainError = KeychainError;
class KeychainNotAvailableError extends KeychainError {
    constructor(platform, hint) {
        super(`Keychain not available on ${platform}. ${hint}`);
        this.name = 'KeychainNotAvailableError';
    }
}
exports.KeychainNotAvailableError = KeychainNotAvailableError;
//# sourceMappingURL=types.js.map