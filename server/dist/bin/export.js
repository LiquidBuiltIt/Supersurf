#!/usr/bin/env node
"use strict";
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
exports.getSessionsDir = getSessionsDir;
exports.findUsageLogs = findUsageLogs;
exports.buildOutputName = buildOutputName;
exports.runExportProgram = runExportProgram;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
/** Absolute path to the per-session log directory under ~/.supersurf. */
function getSessionsDir(homedir = os.homedir()) {
    return path.join(homedir, '.supersurf', 'logs', 'sessions');
}
/**
 * Collect exactly the files /usage-data-audit consumes: the current
 * `metrics-*.ndjson` trail and the legacy `audit-*.ndjson` trail. Returns
 * sorted absolute paths; an empty array if the directory is missing/unreadable.
 */
function findUsageLogs(sessionsDir) {
    let names;
    try {
        names = fs.readdirSync(sessionsDir);
    }
    catch {
        return [];
    }
    return names
        .filter((n) => (n.startsWith('metrics-') || n.startsWith('audit-')) &&
        n.endsWith('.ndjson'))
        .sort()
        .map((n) => path.join(sessionsDir, n));
}
/** Filesystem-safe, timestamped archive name. */
function buildOutputName(now) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    return `supersurf-usage-logs-${stamp}.zip`;
}
/** Default archiver: shell to the OS-native `zip` CLI, junking directory paths. */
function defaultZip(outPath, files) {
    // -j junks paths (store bare filenames), -q quiet. Errors surface as a thrown
    // Error whose `.code` is 'ENOENT' when the `zip` binary is not on PATH.
    (0, node_child_process_1.execFileSync)('zip', ['-j', '-q', outPath, ...files], {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
}
/**
 * `supersurf export` — bundle usage-metrics logs into a .zip in the caller's
 * cwd. Takes no flags; `argv` is accepted only for dispatcher-signature parity.
 * Returns a process exit code (0 = success, 1 = failure).
 */
async function runExportProgram(_argv, deps = {}) {
    const sessionsDir = deps.sessionsDir ?? getSessionsDir();
    const cwd = deps.cwd ?? process.cwd();
    const now = deps.now ?? new Date();
    const zip = deps.zip ?? defaultZip;
    const out = deps.stdout ?? ((m) => process.stdout.write(m));
    const err = deps.stderr ?? ((m) => process.stderr.write(m));
    const files = findUsageLogs(sessionsDir);
    if (files.length === 0) {
        err(`[export] No usage-metrics logs found in ${sessionsDir}\n`);
        err(`[export] Nothing to export — enable logging.usage_metrics in ` +
            `~/.supersurf/config.json and run a session first.\n`);
        return 1;
    }
    const outPath = path.join(cwd, buildOutputName(now));
    try {
        zip(outPath, files);
    }
    catch (e) {
        if (e && e.code === 'ENOENT') {
            err(`[export] The 'zip' CLI was not found on PATH. Install it ` +
                `(e.g. 'sudo apt install zip' or 'brew install zip') and retry.\n`);
        }
        else {
            err(`[export] Failed to create archive: ${e?.message ?? String(e)}\n`);
        }
        return 1;
    }
    out(`[export] Bundled ${files.length} usage-log file(s) into ${outPath}\n`);
    return 0;
}
if (require.main === module) {
    runExportProgram(process.argv).then((code) => process.exit(code));
}
//# sourceMappingURL=export.js.map