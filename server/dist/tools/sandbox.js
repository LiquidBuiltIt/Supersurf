"use strict";
/**
 * Path sandboxing for agent-controlled file writes.
 *
 * All paths from agent input are resolved relative to $HOME.
 * Traversal outside $HOME is rejected with a generic error
 * to prevent information leakage about the filesystem.
 *
 * @module tools/sandbox
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sandboxPath = sandboxPath;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
/**
 * Resolve an agent-supplied path safely within $HOME.
 *
 * - Absolute paths like `/etc/foo` become `$HOME/etc/foo`
 * - Relative paths like `Desktop/file.png` resolve to `$HOME/Desktop/file.png`
 * - Traversal via `..` that escapes $HOME throws "Permission denied"
 *
 * @param userPath - Raw path string from agent input
 * @returns Resolved absolute path guaranteed to be within $HOME
 * @throws Error with "Permission denied" if path escapes $HOME
 */
function sandboxPath(userPath) {
    const home = os_1.default.homedir();
    // Strip leading slash to make absolute paths relative to $HOME
    const stripped = userPath.replace(/^\/+/, '');
    const resolved = path_1.default.resolve(home, stripped);
    // Ensure the resolved path is within $HOME
    if (!resolved.startsWith(home + path_1.default.sep) && resolved !== home) {
        throw new Error('Permission denied');
    }
    return resolved;
}
//# sourceMappingURL=sandbox.js.map