"use strict";
/**
 * Playbook file validation — read, hash, parse meta, static-analyze.
 *
 * All three gates must pass for `valid: true`:
 *   1. `parseMeta` — the meta literal is present, pure, and well-shaped
 *   2. `analyzeWithRules(source, nodeRules)` — no blocked Node constructs
 *   3. the declared-vs-used permission check — a file that calls
 *      `supersurf.evaluate` must declare `permissions: ['eval']`
 *
 * A record is returned for every outcome. `file`, `name`, `hash` and
 * `signature` are always populated so a caller can list a broken playbook
 * alongside the reason it is broken.
 *
 * @module security/validate
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.playbookName = playbookName;
exports.buildSignature = buildSignature;
exports.validateFile = validateFile;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const analyzer_1 = require("./analyzer");
const node_1 = require("./rules/node");
const meta_1 = require("./meta");
/** Strip the `.playbook.js` suffix from a path to get the playbook's name. */
function playbookName(filePath) {
    return path_1.default.basename(filePath).replace(/\.playbook\.js$/, '');
}
/** Render the one-line call signature: `post_tweet(text, pin?)`. */
function buildSignature(name, meta) {
    const params = meta?.params ?? {};
    const rendered = Object.entries(params).map(([k, spec]) => (spec.required ? k : `${k}?`));
    return `${name}(${rendered.join(', ')})`;
}
/** Read, hash, parse and statically analyze one playbook file. Never throws. */
async function validateFile(filePath) {
    const name = playbookName(filePath);
    const base = {
        file: filePath,
        name,
        signature: buildSignature(name),
        validatedAt: Date.now(),
    };
    let source;
    try {
        source = await promises_1.default.readFile(filePath, 'utf8');
    }
    catch (e) {
        return { ...base, hash: '', valid: false, error: `could not read ${filePath}: ${e?.message ?? String(e)}` };
    }
    const hash = crypto_1.default.createHash('sha256').update(source).digest('hex');
    const { meta, error } = (0, meta_1.parseMeta)(source);
    if (!meta) {
        return { ...base, hash, valid: false, error };
    }
    const analysis = (0, analyzer_1.analyzeWithRules)(source, node_1.nodeRules);
    if (!analysis.safe) {
        return { ...base, hash, valid: false, error: `blocked: ${analysis.reason}` };
    }
    if (!(meta.permissions ?? []).includes('eval')) {
        const evalUse = (0, analyzer_1.analyzeWithRules)(source, node_1.evalUsageRules);
        if (!evalUse.safe) {
            return { ...base, hash, valid: false, error: `blocked: ${evalUse.reason}` };
        }
    }
    return { ...base, hash, valid: true, meta, signature: buildSignature(name, meta) };
}
//# sourceMappingURL=validate.js.map