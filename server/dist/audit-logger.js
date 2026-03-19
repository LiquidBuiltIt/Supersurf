"use strict";
/**
 * AuditLogger — structured NDJSON audit log for every tool call per session.
 *
 * Always-on (not gated behind DEBUG_MODE). Writes to
 * `~/.supersurf/logs/sessions/audit-{sessionId}-{timestamp}.ndjson`.
 *
 * @module audit-logger
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogger = void 0;
exports.redactParams = redactParams;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const AUDIT_DIR = path_1.default.join(os_1.default.homedir(), '.supersurf', 'logs', 'sessions');
const SENSITIVE_KEYS = new Set(['value', 'password', 'token', 'secret', 'credential']);
/** Keys whose values are too large to log (base64 blobs, etc.) */
const STRIP_KEYS = new Set(['data']);
function redactParams(params) {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        const lower = k.toLowerCase();
        if (STRIP_KEYS.has(lower))
            continue;
        out[k] = SENSITIVE_KEYS.has(lower) ? '[REDACTED]' : v;
    }
    return out;
}
class AuditLogger {
    _path;
    constructor(sessionId, auditDir) {
        const dir = auditDir ?? AUDIT_DIR;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
        this._path = path_1.default.join(dir, `audit-${safe}-${ts}.ndjson`);
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
    write(entry) {
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            ...entry,
            params: redactParams(entry.params),
        });
        fs_1.default.appendFileSync(this._path, line + '\n');
    }
    getPath() {
        return this._path;
    }
}
exports.AuditLogger = AuditLogger;
//# sourceMappingURL=audit-logger.js.map