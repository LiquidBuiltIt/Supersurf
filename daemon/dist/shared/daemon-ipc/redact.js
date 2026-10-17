"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactForLog = redactForLog;
/**
 * Debug-log guard: `secure_fill` carries the resolved credential in `params.value`.
 * Only that command is redacted; other commands' `value` stays visible for debugging.
 */
function redactForLog(method, params) {
    if (method === 'secure_fill' && params && typeof params === 'object' && 'value' in params) {
        return { ...params, value: '[redacted]' };
    }
    return params;
}
//# sourceMappingURL=redact.js.map