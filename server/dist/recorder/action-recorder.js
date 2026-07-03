"use strict";
/**
 * Action recorder — records what each interaction action targeted and what
 * happened, to the usage-metrics trail. Gated by logging.usage_metrics
 * (the same leaf that enables the usage-metrics logger), core infra
 * (NOT an experiment). Records only; downstream tooling
 * (fingerprinting / self-healing) consumes this chokepoint separately.
 *
 * @module recorder/action-recorder
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordAction = recordAction;
function truncate(s, n = 200) {
    return s.length > n ? s.slice(0, n) + '…' : s;
}
/**
 * Record one action's target + outcome. Called from executeAction on both the
 * success and error paths. Gated by logging.usage_metrics. NEVER throws.
 */
function recordAction(ctx, action, startedAt, result, error) {
    try {
        if (ctx?.config?.get?.()?.logging?.usage_metrics !== true)
            return;
        const rec = {
            event: 'action',
            type: typeof action?.type === 'string' ? action.type : 'unknown',
            selector: typeof action?.selector === 'string' ? action.selector : null,
            x: typeof action?.x === 'number' ? action.x : null,
            y: typeof action?.y === 'number' ? action.y : null,
            outcome: error ? 'error' : 'ok',
            message: error
                ? truncate(error instanceof Error ? error.message : String(error))
                : (typeof result === 'string' ? truncate(result) : null),
            duration_ms: Date.now() - startedAt,
        };
        ctx?.metricsLogger?.write({
            session_id: ctx?.connectionManager?.clientId ?? 'unknown',
            tool: 'action',
            params: rec,
            result: rec.outcome,
            url: ctx?.connectionManager?.getAttachedTab?.()?.url,
            duration_ms: rec.duration_ms,
        });
    }
    catch {
        /* recorder is best-effort; never disrupt the interaction */
    }
}
//# sourceMappingURL=action-recorder.js.map