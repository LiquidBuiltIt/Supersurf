"use strict";
/**
 * Playbook persistence — ONE FILE PER PLAYBOOK.
 *
 * Deliberately not a single index file. This repo has no file locking anywhere
 * and `writeFileSync` is last-write-wins, so a shared index would silently drop
 * a write whenever the CLI and the MCP server touched it at once — which is the
 * expected flow, since removal is CLI-only while creation is agent-driven.
 * Separate files mean `rm` and `create` never contend unless they name the same
 * playbook, and that case is already an explicit collision error.
 *
 * No memo cache here, unlike `experimental/fingerprinting/store.ts`: playbook
 * reads happen once per `run`, not per DOM node, so a cache would add a
 * staleness class for no measurable gain.
 *
 * @module playbooks/store
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
exports.setBaseDirForTests = setBaseDirForTests;
exports.getBaseDir = getBaseDir;
exports.normalizeName = normalizeName;
exports.playbookExists = playbookExists;
exports.loadPlaybook = loadPlaybook;
exports.savePlaybook = savePlaybook;
exports.removePlaybook = removePlaybook;
exports.listPlaybooks = listPlaybooks;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
let baseDir = path.join(os.homedir(), '.supersurf', 'playbooks');
/** Test-only override of the storage directory. */
function setBaseDirForTests(dir) {
    baseDir = dir;
}
function getBaseDir() {
    return baseDir;
}
/**
 * Normalize a name to snake_case. Never rejects on shape — the repo rule is
 * normalize, don't fault. Path separators are stripped, so a name can never
 * address a file outside the playbook directory.
 */
function normalizeName(raw) {
    return raw
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_')
        .toLowerCase();
}
function fileFor(name) {
    return path.join(baseDir, `${normalizeName(name)}.json`);
}
function playbookExists(name) {
    return fs.existsSync(fileFor(name));
}
function loadPlaybook(name) {
    try {
        return JSON.parse(fs.readFileSync(fileFor(name), 'utf8'));
    }
    catch {
        // Missing or unparseable are the same answer to the caller: no playbook.
        return null;
    }
}
/**
 * Write a playbook. Mode 0600 because steps carry the exact params used to
 * re-issue an action, which for a `type` step includes whatever text was typed.
 */
function savePlaybook(pb) {
    fs.mkdirSync(baseDir, { recursive: true });
    const file = fileFor(pb.name);
    fs.writeFileSync(file, JSON.stringify(pb, null, 2), { mode: 0o600 });
    // mkdir/writeFile honor umask on some platforms; force the mode explicitly.
    fs.chmodSync(file, 0o600);
}
function removePlaybook(name) {
    try {
        fs.unlinkSync(fileFor(name));
        return true;
    }
    catch {
        return false;
    }
}
/** Every readable playbook. Corrupt files are skipped, not fatal. */
function listPlaybooks() {
    let names;
    try {
        names = fs.readdirSync(baseDir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const f of names) {
        if (!f.endsWith('.json'))
            continue;
        const pb = loadPlaybook(f.slice(0, -'.json'.length));
        if (pb)
            out.push(pb);
    }
    return out;
}
//# sourceMappingURL=store.js.map