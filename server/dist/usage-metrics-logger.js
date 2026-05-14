"use strict";
/**
 * UsageMetricsLogger — structured NDJSON usage-metrics log for every tool call per session.
 *
 * Gated by `config.logging.usage_metrics` (default true in scaffolded config,
 * false in raw hardcoded defaults). Writes to
 * `~/.supersurf/logs/sessions/metrics-{sessionId}-{timestamp}.ndjson`.
 *
 * Renamed from `AuditLogger` in v2.0.0; older logs are at `audit-*.ndjson`.
 *
 * @module usage-metrics-logger
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsageMetricsLogger = void 0;
exports.redactParams = redactParams;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const PKG_VERSION = (() => {
    try {
        const pkg = JSON.parse(fs_1.default.readFileSync(path_1.default.join(__dirname, '..', 'package.json'), 'utf8'));
        return pkg.version ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
})();
const METRICS_DIR = path_1.default.join(os_1.default.homedir(), '.supersurf', 'logs', 'sessions');
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
class UsageMetricsLogger {
    filePath;
    constructor(sessionId, metricsDir) {
        const dir = metricsDir ?? METRICS_DIR;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
        this.filePath = path_1.default.join(dir, `metrics-${safe}-${ts}.ndjson`);
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
    write(entry) {
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            version: PKG_VERSION,
            ...entry,
            params: redactParams(entry.params),
        });
        fs_1.default.appendFileSync(this.filePath, line + '\n');
    }
    /** @deprecated Use the readonly `filePath` field. Kept for callers transitioning from v1.x. */
    getPath() {
        return this.filePath;
    }
}
exports.UsageMetricsLogger = UsageMetricsLogger;
//# sourceMappingURL=usage-metrics-logger.js.map