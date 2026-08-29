"use strict";
/**
 * The playbook validation cache.
 *
 * Validation is stat-on-tool-call (spec §4): `refreshRegistry()` runs once at
 * the top of `ConnectionManager.callTool()`, and the verdict rides that tool's
 * result. Two gates keep the cost near zero on the common path —
 *
 *   1. `stat` (mtime + size) decides whether to read the file at all;
 *   2. the sha256 content hash decides whether to re-validate.
 *
 * So `touch` costs a stat, and an editor that rewrites identical bytes costs a
 * read. Only genuinely different content pays for a parse.
 *
 * Reads are SYNCHRONOUS on purpose: `statusHeader()` is sync and must be able
 * to see the registry without awaiting anything.
 *
 * @module playbooks/registry
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.setValidatorForTests = setValidatorForTests;
exports.resetRegistryForTests = resetRegistryForTests;
exports.refreshRegistry = refreshRegistry;
exports.getRecords = getRecords;
exports.getRecord = getRecord;
exports.getInvalidRecords = getInvalidRecords;
const fs = __importStar(require("node:fs"));
const crypto = __importStar(require("node:crypto"));
const paths_1 = require("./paths");
const validate_1 = require("../security/validate");
/** file path -> cached validation. */
const cache = new Map();
let validator = validate_1.validateFile;
/** Test seam. Pass `null` to restore the real validator. */
function setValidatorForTests(fn) {
    validator = fn ?? validate_1.validateFile;
}
function resetRegistryForTests() {
    cache.clear();
}
function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}
/**
 * Re-sync the cache with the playbooks directory. Never throws — a broken
 * file becomes an invalid record, which is exactly what the agent should be
 * told about, rather than an exception that takes down an unrelated tool call.
 */
async function refreshRegistry() {
    const files = (0, paths_1.listPlaybookFiles)();
    const seen = new Set();
    for (const file of files) {
        seen.add(file);
        let stat;
        try {
            stat = fs.statSync(file);
        }
        catch {
            continue; // vanished between readdir and stat
        }
        const cached = cache.get(file);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
            continue;
        let hash;
        try {
            hash = sha256(fs.readFileSync(file));
        }
        catch {
            continue;
        }
        if (cached && cached.record.hash === hash) {
            // Same bytes, new stat — refresh the gate, keep the verdict.
            cache.set(file, { record: cached.record, mtimeMs: stat.mtimeMs, size: stat.size });
            continue;
        }
        let record;
        try {
            record = await validator(file);
        }
        catch (err) {
            record = {
                file,
                name: (0, paths_1.nameFromFile)(file),
                hash,
                valid: false,
                error: err?.message ?? String(err),
                signature: '',
                validatedAt: Date.now(),
            };
        }
        cache.set(file, { record, mtimeMs: stat.mtimeMs, size: stat.size });
    }
    for (const file of [...cache.keys()]) {
        if (!seen.has(file))
            cache.delete(file);
    }
}
/** Every known playbook, valid or not, sorted by name. */
function getRecords() {
    return [...cache.values()]
        .map(e => e.record)
        .sort((a, b) => a.name.localeCompare(b.name));
}
function getRecord(name) {
    for (const entry of cache.values()) {
        if (entry.record.name === name)
            return entry.record;
    }
    return undefined;
}
function getInvalidRecords() {
    return getRecords().filter(r => !r.valid);
}
//# sourceMappingURL=registry.js.map