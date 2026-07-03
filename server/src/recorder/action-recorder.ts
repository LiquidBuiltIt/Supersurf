/**
 * Action recorder — records what each interaction action targeted and what
 * happened, to the usage-metrics trail. Gated by logging.usage_metrics
 * (the same leaf that enables the usage-metrics logger), core infra
 * (NOT an experiment). Records only; downstream tooling
 * (fingerprinting / self-healing) consumes this chokepoint separately.
 *
 * @module recorder/action-recorder
 */

/** One recorded interaction action: its target and outcome. */
export interface ActionRecord {
  event: 'action';
  type: string;
  selector: string | null;
  x: number | null;
  y: number | null;
  outcome: 'ok' | 'error';
  message: string | null;
  duration_ms: number;
}

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Record one action's target + outcome. Called from executeAction on both the
 * success and error paths. Gated by logging.usage_metrics. NEVER throws.
 */
export function recordAction(
  ctx: any,
  action: any,
  startedAt: number,
  result: string | null,
  error: unknown,
): void {
  try {
    if (ctx?.config?.get?.()?.logging?.usage_metrics !== true) return;
    const rec: ActionRecord = {
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
      params: rec as unknown as Record<string, unknown>,
      result: rec.outcome,
      url: ctx?.connectionManager?.getAttachedTab?.()?.url,
      duration_ms: rec.duration_ms,
    });
  } catch {
    /* recorder is best-effort; never disrupt the interaction */
  }
}
