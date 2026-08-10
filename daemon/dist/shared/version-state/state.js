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
exports.defaultVersionStatePath = defaultVersionStatePath;
exports.shouldShowUpgradeNotice = shouldShowUpgradeNotice;
exports.checkAndTouchVersionState = checkAndTouchVersionState;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
/** Default location of the version-state file: `~/.supersurf/version-state.json`. */
function defaultVersionStatePath() {
    return path.join(os.homedir(), '.supersurf', 'version-state.json');
}
/** Extract the major component of a semver-ish `x.y.z` string, or null if unparsable. */
function parseMajor(version) {
    if (typeof version !== 'string')
        return null;
    const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m)
        return null;
    return parseInt(m[1], 10);
}
/**
 * True only when both versions parse as semver-ish `x.y.z` and the current
 * major is strictly greater than the last-recorded major. Same-major
 * minor/patch bumps, downgrades, and unparsable input are all false.
 */
function shouldShowUpgradeNotice(lastVersion, currentVersion) {
    const lastMajor = parseMajor(lastVersion);
    const currentMajor = parseMajor(currentVersion);
    if (lastMajor === null || currentMajor === null)
        return false;
    return currentMajor > lastMajor;
}
/** Best-effort read — any missing file, I/O error, or malformed JSON yields null. */
function readVersionState(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return null;
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return null;
        if (typeof parsed.last_version !== 'string')
            return null;
        return {
            last_version: parsed.last_version,
            last_used_at: typeof parsed.last_used_at === 'string' ? parsed.last_used_at : '',
        };
    }
    catch {
        return null;
    }
}
/** Best-effort write — swallows any I/O error rather than throwing. */
function writeVersionState(filePath, state) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    }
    catch {
        // Best-effort — a failed write must never surface to the caller.
    }
}
/**
 * Read the version-state file, decide whether to show the major-version
 * upgrade notice, then record the current version + timestamp. Never
 * throws: any FS/parse error is treated as "no notice" (first-run behavior)
 * and the write is best-effort.
 */
function checkAndTouchVersionState(currentVersion, filePath = defaultVersionStatePath()) {
    let shouldNotify = false;
    try {
        const state = readVersionState(filePath);
        shouldNotify = shouldShowUpgradeNotice(state ? state.last_version : null, currentVersion);
    }
    catch {
        shouldNotify = false;
    }
    writeVersionState(filePath, { last_version: currentVersion, last_used_at: new Date().toISOString() });
    return { shouldNotify };
}
//# sourceMappingURL=state.js.map