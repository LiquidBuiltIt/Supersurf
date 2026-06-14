/**
 * Action recorder — records what each interaction action targeted and what
 * happened, to the usage-metrics trail. Config-gated (logging.action_recording),
 * core infra (NOT an experiment). Records only; downstream tooling
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
/**
 * Record one action's target + outcome. Called from executeAction on both the
 * success and error paths. Gated by logging.action_recording. NEVER throws.
 */
export declare function recordAction(ctx: any, action: any, startedAt: number, result: string | null, error: unknown): void;
//# sourceMappingURL=action-recorder.d.ts.map