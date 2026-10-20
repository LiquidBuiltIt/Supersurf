/**
 * Debug-log guard: `secure_fill` carries the resolved credential in `params.value`.
 * Only that command is redacted; other commands' `value` stays visible for debugging.
 */
export function redactForLog(method: string, params: unknown): unknown {
  if (method === 'secure_fill' && params && typeof params === 'object' && 'value' in params) {
    return { ...params, value: '[redacted]' };
  }
  return params;
}
