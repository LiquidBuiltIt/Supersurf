import type { EvalFn } from '../../tools/lib/element-resolver';
import { getElementCenter } from '../../tools/lib/element-resolver';
import { experimentRegistry } from '../index';
import { getRecord, putRecord } from './store';
import { captureExpr, scoreExpr } from './page-scripts';
import type { Fingerprint, FingerprintRecord, ScoreHit } from './types';

export const THRESHOLD = 0.6;
export const MARGIN = 0.10;

export function domainOf(url: string | undefined): string {
  try {
    const u = new URL(url || '');
    // file:// pages have no hostname but are real, automatable pages — give them
    // a dedicated bucket (route = path) instead of collapsing into 'unknown'.
    if (u.protocol === 'file:') return 'file';
    return u.hostname.replace(/^www\./, '') || 'unknown';
  } catch { return 'unknown'; }
}
export function routeOf(url: string | undefined): string {
  try { return new URL(url || '').pathname || '/'; } catch { return '/'; }
}

export function passesGate(hit: ScoreHit): boolean {
  return hit.score >= THRESHOLD && hit.margin >= MARGIN;
}

function safeParse<T>(s: any): T | null {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

/** Fire-and-forget: fingerprint the just-resolved element and persist it. Never throws. */
export async function captureOnResolve(evalFn: EvalFn, url: string | undefined, selector: string): Promise<void> {
  try {
    const raw = await evalFn(captureExpr(selector));
    const fp = safeParse<Fingerprint>(raw);
    if (!fp) return;
    const domain = domainOf(url), route = routeOf(url);
    // Never persist into the 'unknown' bucket: a stale/empty attached-tab URL would
    // mis-file the record under unknown.json where it can never be healed (heal keys
    // off the live domain). Drop it instead — the record is best-effort anyway.
    if (domain === 'unknown') return;
    const existing = getRecord(domain, route, selector);
    const now = Date.now();
    const rec: FingerprintRecord = {
      ...fp, selector,
      capturedAt: existing?.capturedAt ?? now,
      lastSeenAt: now,
      hits: (existing?.hits ?? 0) + 1,
    };
    putRecord(domain, route, selector, rec);
  } catch {
    /* capture is best-effort; never disrupt the resolve */
  }
}

/**
 * Capture an element resolved inside a child frame (iframe). The top-frame capture path
 * (`resolveWithHealing`) can't see iframe elements because it evals against the top frame,
 * so `getCenterInFrame`'s frame-walk fallback calls this with an `evalFn` already bound to
 * the child frame's execution context. Gated + fire-and-forget; never throws.
 */
export async function captureInContext(evalInContext: EvalFn, url: string | undefined, selector: string): Promise<void> {
  if (!experimentRegistry.isEnabled('fingerprinting')) return;
  await captureOnResolve(evalInContext, url, selector);
}

/** Outcome of a heal attempt, with enough detail for telemetry on every branch. */
export interface HealAttempt {
  hadRecord: boolean;        // was a stored fingerprint found for this selector?
  score: number | null;     // best candidate score (null if no record / scorer returned nothing)
  margin: number | null;    // best − runner-up
  hit: ScoreHit | null;     // non-null ONLY when the gate passed (safe to heal)
}

/** On a selector miss, try to heal via stored fingerprint. Returns the attempt detail; `hit` is set only when the gate passes. */
export async function healOnMiss(evalFn: EvalFn, url: string | undefined, selector: string): Promise<HealAttempt> {
  const rec = getRecord(domainOf(url), routeOf(url), selector);
  if (!rec) return { hadRecord: false, score: null, margin: null, hit: null };
  const raw = await evalFn(scoreExpr(JSON.stringify(rec)));
  const scored = safeParse<ScoreHit>(raw);
  if (!scored) return { hadRecord: true, score: null, margin: null, hit: null };
  return { hadRecord: true, score: scored.score, margin: scored.margin, hit: passesGate(scored) ? scored : null };
}

/**
 * Heal a selector miss inside a child frame (iframe). The top-frame heal path
 * (`resolveWithHealing`) evals against the top frame, so it can't see iframe
 * elements; `getCenterInFrame`'s frame-walk fallback calls this with an `evalFn`
 * already bound to a child frame's execution context. Returns the gate-passing
 * hit's **iframe-local** center + score/margin (the caller translates to
 * top-frame coords), or null when there's no record / the gate fails. Gated;
 * never throws.
 */
export async function healInContext(evalInContext: EvalFn, url: string | undefined, selector: string): Promise<ScoreHit | null> {
  if (!experimentRegistry.isEnabled('fingerprinting')) return null;
  try {
    const attempt = await healOnMiss(evalInContext, url, selector);
    return attempt.hit; // non-null ONLY when the gate passed
  } catch {
    return null;
  }
}

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
export async function resolveWithHealing(
  evalFn: EvalFn,
  selector: string,
  getUrl: () => string | undefined,
  emit?: HealEmit,
): Promise<{ x: number; y: number }> {
  if (!experimentRegistry.isEnabled('fingerprinting')) {
    return getElementCenter(evalFn, selector);
  }
  const url = getUrl();
  const domain = domainOf(url), route = routeOf(url);
  const fire = (outcome: HealEvent['outcome'], score: number | null, margin: number | null, hadRecord: boolean) => {
    try { emit?.({ event: 'fingerprint', outcome, selector, domain, route, score, margin, hadRecord }); } catch { /* telemetry must never break a resolve */ }
  };
  try {
    const center = await getElementCenter(evalFn, selector);
    // fire-and-forget capture; do not await (keeps resolve latency unchanged)
    void captureOnResolve(evalFn, url, selector);
    fire('resolved', null, null, false);
    return center;
  } catch (missErr) {
    try {
      const attempt = await healOnMiss(evalFn, url, selector);
      if (attempt.hit) {
        fire('healed', attempt.score, attempt.margin, true);
        return { x: attempt.hit.cx, y: attempt.hit.cy };
      }
      fire('escalated', attempt.score, attempt.margin, attempt.hadRecord);
    } catch {
      fire('escalated', null, null, false);
    }
    throw missErr; // escalate = original "Element not found" error
  }
}
