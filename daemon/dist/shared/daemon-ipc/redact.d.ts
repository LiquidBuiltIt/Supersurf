/**
 * Debug-log guard: `secure_fill` carries the resolved credential in `params.value`.
 * Only that command is redacted; other commands' `value` stays visible for debugging.
 */
export declare function redactForLog(method: string, params: unknown): unknown;
//# sourceMappingURL=redact.d.ts.map