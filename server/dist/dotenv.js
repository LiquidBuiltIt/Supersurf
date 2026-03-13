"use strict";
/**
 * Minimal .env file loader. Reads KEY=VALUE pairs from a .env file into process.env.
 * Does not override existing vars. Tracks loaded key names for credential discovery.
 *
 * @module dotenv
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDotenvKeys = getDotenvKeys;
exports.loadDotenv = loadDotenv;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/** Keys loaded from .env — only names, never values. */
const dotenvKeys = [];
/** Get the list of env var names loaded from .env. */
function getDotenvKeys() {
    return dotenvKeys;
}
/**
 * Load a .env file into process.env. Does not override existing vars.
 * Supports KEY=VALUE, KEY="VALUE", KEY='VALUE', comments (#), and blank lines.
 */
function loadDotenv(dir) {
    const envPath = path_1.default.join(dir, '.env');
    if (!fs_1.default.existsSync(envPath))
        return;
    const lines = fs_1.default.readFileSync(envPath, 'utf8').split('\n');
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1)
            continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        // Don't override existing env vars
        if (process.env[key] === undefined) {
            process.env[key] = val;
        }
        dotenvKeys.push(key);
    }
}
//# sourceMappingURL=dotenv.js.map