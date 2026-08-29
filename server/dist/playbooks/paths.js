"use strict";
/**
 * Where playbook scripts live and what they are called.
 *
 * The filename IS the address — `meta` carries no `name` field (spec §7.3).
 * `<name>.playbook.js` is the script; `<name>.runs.jsonl` is its append-only
 * run sidecar (spec §7.8), which is why the extension check below is
 * suffix-exact rather than a bare `.js` test.
 *
 * @module playbooks/paths
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
exports.RUNS_EXT = exports.PLAYBOOK_EXT = void 0;
exports.setPlaybooksDirForTests = setPlaybooksDirForTests;
exports.getPlaybooksDir = getPlaybooksDir;
exports.normalizeName = normalizeName;
exports.playbookFile = playbookFile;
exports.runsFile = runsFile;
exports.nameFromFile = nameFromFile;
exports.listPlaybookFiles = listPlaybookFiles;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
exports.PLAYBOOK_EXT = '.playbook.js';
exports.RUNS_EXT = '.runs.jsonl';
let baseDir = path.join(os.homedir(), '.supersurf', 'playbooks');
/** Test-only override of the playbooks directory. */
function setPlaybooksDirForTests(dir) {
    baseDir = dir;
}
function getPlaybooksDir() {
    return baseDir;
}
/**
 * Normalize a name to snake_case. Never rejects on shape — the repo rule is
 * normalize, don't fault. Path separators collapse into underscores, so a
 * name can never address a file outside the playbook directory.
 */
function normalizeName(raw) {
    return raw
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_')
        .toLowerCase();
}
function playbookFile(name) {
    return path.join(baseDir, `${normalizeName(name)}${exports.PLAYBOOK_EXT}`);
}
function runsFile(name) {
    return path.join(baseDir, `${normalizeName(name)}${exports.RUNS_EXT}`);
}
/** Basename minus the playbook extension — the inverse of `playbookFile`. */
function nameFromFile(file) {
    return path.basename(file).slice(0, -exports.PLAYBOOK_EXT.length);
}
/** Absolute paths of every playbook script in the directory, sorted by name. */
function listPlaybookFiles() {
    let entries;
    try {
        entries = fs.readdirSync(baseDir);
    }
    catch {
        return [];
    }
    return entries
        .filter((f) => f.endsWith(exports.PLAYBOOK_EXT))
        .sort((a, b) => a.localeCompare(b))
        .map((f) => path.join(baseDir, f));
}
//# sourceMappingURL=paths.js.map