import type { EvalFn } from '../../tools/lib/element-resolver';
import type { FingerprintRecord, ScoreHit } from './types';
import type { HandleMeta } from './handle-meta';
export declare const THRESHOLD = 0.6;
export declare const MARGIN = 0.1;
export { domainOf, routeOf } from './url';
export declare function passesGate(hit: ScoreHit): boolean;
/** Handle-capture telemetry, written to the usage-metrics trail when the agent supplies a name. */
export interface HandleEvent {
    event: 'handle.capture';
    outcome: 'new' | 'existing' | 'ignored' | 'none';
    /** The canonical name now bound to this element. */
    name: string;
    /** Set only on `outcome: 'ignored'` — the differing name the agent sent, which was discarded. */
    ignoredName?: string;
    purpose_present: boolean;
    normalized: boolean;
    domain: string;
    route: string;
    selector: string;
}
/** Resolve-by-name telemetry. Fires on every translation attempt, hit or miss, so the
 *  usage-metrics trail can measure handle adoption and handle accuracy separately. */
export interface HandleResolveEvent {
    event: 'handle.resolved';
    /** The handle name the agent passed (normalized shape, as supplied). */
    name: string;
    match: 'canonical' | 'miss';
    /** Records in this domain+route carrying the name; 0 on a miss. */
    candidateCount: number;
    /** The translated selector; '' on a miss. */
    selector: string;
    domain: string;
    route: string;
}
export type AnyHandleEvent = HandleEvent | HandleResolveEvent;
export type HandleEmit = (ev: AnyHandleEvent) => void;
/** Fire-and-forget: fingerprint the just-resolved element and persist it, binding an
 *  optional agent-supplied handle name/purpose via mergeHandleMeta (sticky-canonical, never an alias). Never throws.
 *  `preloadedRecord`, when passed (even as `null`), is reused as-is instead of re-reading via
 *  `getRecord` — callers that already looked up the record (e.g. `resolveWithHealing`, for its
 *  `hadRecord` telemetry) pass it through so the happy path stays at one file read, not two. */
export declare function captureOnResolve(evalFn: EvalFn, url: string | undefined, selector: string, meta?: HandleMeta, emitHandle?: HandleEmit, preloadedRecord?: FingerprintRecord | null): Promise<void>;
/**
 * Capture an element resolved inside a child frame (iframe). The top-frame capture path
 * (`resolveWithHealing`) can't see iframe elements because it evals against the top frame,
 * so `getCenterInFrame`'s frame-walk fallback calls this with an `evalFn` already bound to
 * the child frame's execution context. Gated + fire-and-forget; never throws.
 */
export declare function captureInContext(evalInContext: EvalFn, url: string | undefined, selector: string, meta?: HandleMeta, emitHandle?: HandleEmit): Promise<void>;
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
    /** True iff a stored fingerprint already existed for this exact domain+route+selector key at
     *  resolve time. This is identity of the *storage key*, not of the underlying DOM element or
     *  its meaning — a selector can be reused across unrelated elements/pages and still read true. */
    hadRecord: boolean;
    /** 1:1 derived from `hadRecord`: 'known' when a record existed for this selector-key, 'new' on
     *  first contact. Lets the usage-metrics trail distinguish cold-start resolves from steady-state. */
    discovery: 'new' | 'known';
}
export type HealEmit = (ev: HealEvent) => void;
/**
 * Drop-in wrapper for getElementCenter. When the experiment is OFF, behaves identically
 * to getElementCenter. When ON: captures on success, heals on miss, escalates (rethrows)
 * if healing fails.
 */
export declare function resolveWithHealing(evalFn: EvalFn, selector: string, getUrl: () => string | undefined, emit?: HealEmit, meta?: HandleMeta, emitHandle?: HandleEmit): Promise<{
    x: number;
    y: number;
}>;
//# sourceMappingURL=index.d.ts.map