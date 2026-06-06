"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinuxKeychainBackend = exports.MacosKeychainBackend = exports.InMemoryKeychainBackend = exports.SUPERSURF_SERVICE = exports.KeychainNotAvailableError = exports.KeychainError = void 0;
exports.getKeychainBackend = getKeychainBackend;
const types_1 = require("./types");
const macos_1 = require("./macos");
const linux_1 = require("./linux");
var types_2 = require("./types");
Object.defineProperty(exports, "KeychainError", { enumerable: true, get: function () { return types_2.KeychainError; } });
Object.defineProperty(exports, "KeychainNotAvailableError", { enumerable: true, get: function () { return types_2.KeychainNotAvailableError; } });
Object.defineProperty(exports, "SUPERSURF_SERVICE", { enumerable: true, get: function () { return types_2.SUPERSURF_SERVICE; } });
var inmemory_1 = require("./inmemory");
Object.defineProperty(exports, "InMemoryKeychainBackend", { enumerable: true, get: function () { return inmemory_1.InMemoryKeychainBackend; } });
var macos_2 = require("./macos");
Object.defineProperty(exports, "MacosKeychainBackend", { enumerable: true, get: function () { return macos_2.MacosKeychainBackend; } });
var linux_2 = require("./linux");
Object.defineProperty(exports, "LinuxKeychainBackend", { enumerable: true, get: function () { return linux_2.LinuxKeychainBackend; } });
function getKeychainBackend(platform = process.platform) {
    if (platform === 'darwin')
        return new macos_1.MacosKeychainBackend();
    if (platform === 'linux')
        return new linux_1.LinuxKeychainBackend();
    throw new types_1.KeychainNotAvailableError(platform, 'SuperSurf credentials require macOS or Linux. Use env vars as a fallback.');
}
//# sourceMappingURL=index.js.map