import type { EvalFn } from '../../tools/lib/element-resolver';
import { getElementCenter } from '../../tools/lib/element-resolver';
import { experimentRegistry } from '../index';
import { getRecord, putRecord } from './store';
import { captureExpr, scoreExpr } from './page-scripts';
import type { Fingerprint, FingerprintRecord, ScoreHit } from './types';
import { mergeHandleMeta } from './handle-meta';
import type { HandleMeta } from './handle-meta';

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

/** Handle-capture telemetry, written to the usage-metrics trail when the agent supplies a name. */
export interface HandleEvent {
  event: 'handle.capture' | 'handle.alias_added';
  outcome: 'new' | 'alias' | 'existing' | 'none';
  name: string;
  purpose_present: boolean;
  normalized: boolean;
  aliasCount: number;
  addedAlias?: string;
  aliasFreq?: number;
  domain: string;
  route: string;
  selector: string;
}
export type HandleEmit = (ev: HandleEvent) => void;

/** Fire-and-forget: fingerprint the just-resolved element and persist it, binding an
 *  optional agent-supplied handle name/purpose (canonical-vs-alias via mergeHandleMeta). Never throws.
 *  `preloadedRecord`, when passed (even as `null`), is reused as-is instead of re-reading via
 *  `getRecord` — callers that already looked up the record (e.g. `resolveWithHealing`, for its
 *  `hadRecord` telemetry) pass it through so the happy path stays at one file read, not two. */
export async function captureOnResolve(
  evalFn: EvalFn,
  url: string | undefined,
  selector: string,
  meta?: HandleMeta,
  emitHandle?: HandleEmit,
  preloadedRecord?: FingerprintRecord | null,
): Promise<void> {
  try {
    const raw = await evalFn(captureExpr(selector));
    const fp = safeParse<Fingerprint>(raw);
    if (!fp) return;
    const domain = domainOf(url), route = routeOf(url);
    // Never persist into the 'unknown' bucket: a stale/empty attached-tab URL would
    // mis-file the record under unknown.json where it can never be healed (heal keys
    // off the live domain). Drop it instead — the record is best-effort anyway.
    if (domain === 'unknown') return;
    const existing = preloadedRecord !== undefined ? preloadedRecord : getRecord(domain, route, selector);
    const now = Date.now();

    const merged = mergeHandleMeta(
      existing ? { name: existing.handleName, purpose: existing.purpose, aliases: existing.aliases } : undefined,
      meta ?? {},
    );

    const rec: FingerprintRecord = {
      ...fp, selector,
      capturedAt: existing?.capturedAt ?? now,
      lastSeenAt: now,
      hits: (existing?.hits ?? 0) + 1,
      // handle fields (only set when present, keeps records that never got a name clean)
      ...(merged.name !== undefined ? { handleName: merged.name } : {}),
      ...(merged.purpose !== undefined ? { purpose: merged.purpose } : {}),
      ...(merged.aliases !== undefined ? { aliases: merged.aliases } : {}),
    };
    putRecord(domain, route, selector, rec);

    // Emit handle telemetry only when the agent actually supplied a usable name.
    if (emitHandle && merged.outcome !== 'none') {
      const aliasCount = merged.aliases ? Object.keys(merged.aliases).length : 0;
      const fire = (event: HandleEvent['event'], extra: Partial<HandleEvent> = {}) => {
        try {
          emitHandle({
            event, outcome: merged.outcome,
            name: merged.name ?? '', purpose_present: !!merged.purpose,
            normalized: merged.normalized, aliasCount, domain, route, selector, ...extra,
          });
        } catch { /* telemetry must never break capture */ }
      };
      fire('handle.capture');
      if (merged.outcome === 'alias') {
        fire('handle.alias_added', { addedAlias: merged.addedAlias, aliasFreq: merged.aliasFreq });
      }
    }
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
export async function captureInContext(
  evalInContext: EvalFn,
  url: string | undefined,
  selector: string,
  meta?: HandleMeta,
  emitHandle?: HandleEmit,
): Promise<void> {
  if (!experimentRegistry.isEnabled('fingerprinting')) return;
  await captureOnResolve(evalInContext, url, selector, meta, emitHandle);
}

/** Outcome of a heal attempt, with enough detail for telemetry on every branch. */
export interface HealAttempt {
  hadRecord: boolean;        // was a stored fingerprint found for this domain+route+selector key?
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
export async function resolveWithHealing(
  evalFn: EvalFn,
  selector: string,
  getUrl: () => string | undefined,
  emit?: HealEmit,
  meta?: HandleMeta,
  emitHandle?: HandleEmit,
): Promise<{ x: number; y: number }> {
  if (!experimentRegistry.isEnabled('fingerprinting')) {
    return getElementCenter(evalFn, selector);
  }
  const url = getUrl();
  const domain = domainOf(url), route = routeOf(url);
  const fire = (outcome: HealEvent['outcome'], score: number | null, margin: number | null, hadRecord: boolean) => {
    try {
      emit?.({
        event: 'fingerprint', outcome, selector, domain, route, score, margin, hadRecord,
        discovery: hadRecord ? 'known' : 'new',
      });
    } catch { /* telemetry must never break a resolve */ }
  };
  try {
    const center = await getElementCenter(evalFn, selector);
    // Single hoisted read: reused for the `hadRecord` telemetry below AND passed into
    // captureOnResolve so it skips its own getRecord — keeps the happy path at one file
    // read total, not two. (Skip entirely for the 'unknown' domain bucket, which never
    // has records — see captureOnResolve's 'unknown' guard.)
    const existing = domain === 'unknown' ? null : getRecord(domain, route, selector);
    // fire-and-forget capture; do not await (keeps resolve latency unchanged)
    void captureOnResolve(evalFn, url, selector, meta, emitHandle, existing); // now carries handle meta + preloaded record
    fire('resolved', null, null, !!existing);
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
