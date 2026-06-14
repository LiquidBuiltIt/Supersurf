import type { EvalFn } from '../../tools/lib/element-resolver';
import type { ScoreHit } from './types';
export declare const THRESHOLD = 0.6;
export declare const MARGIN = 0.1;
export declare function domainOf(url: string | undefined): string;
export declare function routeOf(url: string | undefined): string;
export declare function passesGate(hit: ScoreHit): boolean;
/** Fire-and-forget: fingerprint the just-resolved element and persist it. Never throws. */
export declare function captureOnResolve(evalFn: EvalFn, url: string | undefined, selector: string): Promise<void>;
/**
 * Capture an element resolved inside a child frame (iframe). The top-frame capture path
 * (`resolveWithHealing`) can't see iframe elements because it evals against the top frame,
 * so `getCenterInFrame`'s frame-walk fallback calls this with an `evalFn` already bound to
 * the child frame's execution context. Gated + fire-and-forget; never throws.
 */
export declare function captureInContext(evalInContext: EvalFn, url: string | undefined, selector: string): Promise<void>;
/** Outcome of a heal attempt, with enough detail for telemetry on every branch. */
export interface HealAttempt {
    hadRecord: boolean;
    score: number | null;
    margin: number | null;
    hit: ScoreHit | null;
}
/** On a selector miss, try to heal via stored fingerprint. Returns the attempt detail; `hit` is set only when the gate passes. */
export declare function healOnMiss(evalFn: EvalFn, url: string | undefined, selector: string): Promise<HealAttempt>;
/**
 * Heal a selector miss inside a child frame (iframe). The top-frame heal path
 * (`resolveWithHealing`) evals against the top frame, so it can't see iframe
 * elements; `getCenterInFrame`'s frame-walk fallback calls this with an `evalFn`
 * already bound to a child frame's execution context. Returns the gate-passing
 * hit's **iframe-local** center + score/margin (the caller translates to
 * top-frame coords), or null when there's no record / the gate fails. Gated;
 * never throws.
 */
export declare function healInContext(evalInContext: EvalFn, url: string | undefined, selector: string): Promise<ScoreHit | null>;
/** Telemetry event emitted per resolve when the experiment is on (written to the usage-metrics trail). */
export interface HealEvent {
    event: 'fingerprint';
    outcome: 'resolved' | 'healed' | 'escalated';
    selector: string;
    domain: string;
    route: string;
    score: number | null;
    margin: number | null;
    hadRecord: boolean;
}
export type HealEmit = (ev: HealEvent) => void;
/**
 * Drop-in wrapper for getElementCenter. When the experiment is OFF, behaves identically
 * to getElementCenter. When ON: captures on success, heals on miss, escalates (rethrows)
 * if healing fails.
 */
export declare function resolveWithHealing(evalFn: EvalFn, selector: string, getUrl: () => string | undefined, emit?: HealEmit): Promise<{
    x: number;
    y: number;
}>;
//# sourceMappingURL=index.d.ts.map