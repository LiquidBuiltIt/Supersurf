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
exports.loadJsonConfig = loadJsonConfig;
exports.loadEnvConfig = loadEnvConfig;
const fs = __importStar(require("fs"));
function loadJsonConfig(filePath) {
    if (!fs.existsSync(filePath)) {
        return { config: {}, warnings: [] };
    }
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    }
    catch (err) {
        return { config: {}, warnings: [`config: failed to read ${filePath}: ${err.message}`] };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        return {
            config: {},
            warnings: [`config: malformed JSON in ${filePath} — using defaults (${err.message})`],
        };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
            config: {},
            warnings: [`config: ${filePath} must be a JSON object — using defaults`],
        };
    }
    return { config: parsed, warnings: [] };
}
const KNOWN_EXPERIMENTS = [
    'page_diffing', 'smart_waiting', 'mouse_humanization', 'fingerprinting',
];
function isKnownExperiment(s) {
    return KNOWN_EXPERIMENTS.includes(s);
}
/** Experiments that graduated to always-on tools. Recognized but rejected — warn and drop. */
const GRADUATED_EXPERIMENTS = {
    storage_inspection: 'graduated in v3.5.0 — browser_storage is always available',
};
function isTruthy(v) {
    if (!v)
        return false;
    const s = v.toLowerCase().trim();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
function loadEnvConfig(env) {
    const out = {};
    const warnings = [];
    if (env.SUPERSURF_PORT !== undefined) {
        const n = Number(env.SUPERSURF_PORT);
        if (!Number.isFinite(n) || n <= 0 || n > 65535) {
            warnings.push(`config: SUPERSURF_PORT=${env.SUPERSURF_PORT} is not a valid port — ignored`);
        }
        else {
            out.daemon = { ...(out.daemon || {}), port: n };
        }
    }
    if (isTruthy(env.SUPERSURF_DISABLE_SECURE_EVAL)) {
        out.security = { ...(out.security || {}), secure_eval: false };
    }
    if (isTruthy(env.SUPERSURF_DISABLE_PLAYBOOK_EVAL)) {
        out.security = { ...(out.security || {}), playbook_eval: false };
    }
    if (env.SUPERSURF_DEBUG !== undefined) {
        if (env.SUPERSURF_DEBUG === 'no_truncate') {
            out.logging = { ...(out.logging || {}), debug: 'no_truncate' };
        }
        else if (isTruthy(env.SUPERSURF_DEBUG)) {
            out.logging = { ...(out.logging || {}), debug: 'truncate' };
        }
        // Falsy values (0, false, off, no) leave the partial untouched so file/defaults take effect.
    }
    if (env.SUPERSURF_EXPERIMENTS) {
        const names = env.SUPERSURF_EXPERIMENTS.split(',').map((s) => s.trim()).filter(Boolean);
        const expOut = {};
        for (const name of names) {
            if (GRADUATED_EXPERIMENTS[name]) {
                warnings.push(`config: SUPERSURF_EXPERIMENTS contains "${name}" (${GRADUATED_EXPERIMENTS[name]}) — ignored`);
            }
            else if (isKnownExperiment(name)) {
                expOut[name] = true;
            }
            else {
                warnings.push(`config: SUPERSURF_EXPERIMENTS contains unknown name "${name}" — ignored`);
            }
        }
        if (Object.keys(expOut).length > 0) {
            out.experiments = { ...(out.experiments || {}), ...expOut };
        }
    }
    if (env.SUPERSURF_SCREENSHOT_OMIT_PATH !== undefined) {
        const mode = env.SUPERSURF_SCREENSHOT_OMIT_PATH.trim().toLowerCase();
        if (mode === 'inline' || mode === 'path' || mode === 'both') {
            out.screenshot = { ...(out.screenshot || {}), omit_path: mode };
        }
        else {
            warnings.push(`config: SUPERSURF_SCREENSHOT_OMIT_PATH=${env.SUPERSURF_SCREENSHOT_OMIT_PATH} is invalid (want inline|path|both) — ignored`);
        }
    }
    return { config: out, warnings };
}
//# sourceMappingURL=loaders.js.map