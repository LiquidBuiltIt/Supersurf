// server/src/experimental/fingerprinting/ephemeral-handles.ts
//
// Ephemeral handles: throwaway `@name` aliases minted onto the "Did you mean?"
// candidate list so an agent can paste a suggestion straight back as a selector.
//
// Three properties define this module, and each one is load-bearing:
//
// 1. EPHEMERAL. Nothing here is ever written to the fingerprint store. Only a
//    name the agent itself supplies via `browser_interact`'s `name` param
//    persists — that is the existing `fingerprinting` behaviour and is
//    untouched. These names die with the session.
// 2. TEXT-DERIVED ONLY. A name comes from visible text or the accessible-name
//    attributes, never from id/class/data-testid tokens. An audit of 3,422 real
//    captured elements showed the broader heuristic produces legal-but-garbage
//    names 21% of the time, and 21.4% of real elements have no text, aria-label,
//    placeholder or value at all. Partial coverage IS the design: no confident
//    text source means NO handle for that candidate, and the (now valid) CSS
//    selector prints alone.
// 3. GATE-INDEPENDENT. The hint fires whether or not the `fingerprinting`
//    experiment is on, so the mint and the lookup must too. Gating them the way
//    `handle-annotate.ts:buildHandleIndex` is gated would print `@handles` that
//    silently fail to resolve on the default configuration.
//
// Session state mirrors `ExperimentRegistry._sessions` (experimental/index.ts:53-63):
// keyed by the `connect` `client_id`, bound and dropped from the same two places
// in `backend/handlers.ts`.

import { normalizeName } from './naming';
import { looksLikeHandle } from './handle-resolve';

/** Per-session cap. Insertion-ordered Map, oldest evicted first. */
const MAX_PER_SESSION = 200;

/** Most tokens a minted name may carry, so one verbose button can't produce a sentence. */
const MAX_TOKENS = 4;

/** One binding: the selector plus the global order in which it was minted. */
interface EphemeralBinding {
  selector: string;
  /** Monotonic mint counter — the tiebreak when two sessions mint the same name. */
  seq: number;
}

/** sessionId -> (handle name -> binding). */
const _sessions: Map<string, Map<string, EphemeralBinding>> = new Map();

/** Monotonic across every session, so "newest" is comparable between them. */
let _seq = 0;

/** Register a session. Called on connect, alongside `experimentRegistry.bind`. */
export function bindSession(sessionId: string): void {
  if (!_sessions.has(sessionId)) _sessions.set(sessionId, new Map());
}

/** Forget every ephemeral name for a session. Called on disconnect. */
export function dropSession(sessionId: string): void {
  _sessions.delete(sessionId);
}

/**
 * Mint a handle name from an element's text sources. Returns `null` — meaning
 * "print the CSS selector alone" — whenever no confident source exists.
 *
 * `taken` is the set of names already minted for THIS candidate list; a
 * collision gets a numeric suffix (`got_it`, `got_it_2`). A bare digit is a
 * legal token under HANDLE_RE, so the suffixed form still resolves.
 *
 * A single-token name (`submit`) cannot satisfy the two-or-more-words grammar,
 * so the element's tag is appended (`submit_button`). The tag is structural,
 * not a class token, so this does not reintroduce the garbage-name problem.
 */
export function mintHandleName(
  sources: { text?: string; label?: string; tag: string },
  taken: Set<string>,
): string | null {
  const raw = (sources.text || '').trim() || (sources.label || '').trim();
  if (!raw) return null;

  const base = normalizeName(raw);
  if (!base) return null;

  let name = base.split('_').slice(0, MAX_TOKENS).join('_');
  if (!name.includes('_')) {
    const tag = normalizeName(sources.tag);
    if (!tag) return null;
    name = `${name}_${tag}`;
  }
  if (!looksLikeHandle(name)) return null;

  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  for (let n = 2; n <= 50; n++) {
    const candidate = `${name}_${n}`;
    if (!taken.has(candidate) && looksLikeHandle(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  return null;
}

/** Bind a minted name to the selector it describes, for this session only. */
export function bindEphemeral(sessionId: string, name: string, selector: string): void {
  if (!sessionId || !name || !selector) return;
  let slot = _sessions.get(sessionId);
  if (!slot) {
    slot = new Map();
    _sessions.set(sessionId, slot);
  }
  slot.delete(name); // re-insert so the newest binding is also the newest entry
  slot.set(name, { selector, seq: ++_seq });
  while (slot.size > MAX_PER_SESSION) {
    const oldest = slot.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    slot.delete(oldest);
  }
}

/**
 * Look up an ephemeral name. Unions across every bound session, for the same
 * reason `ExperimentRegistry.isEnabled` does with no session id: the sole
 * caller (`resolveSelectorOrHandle`) has no session handle and threading one
 * through its ~15 call sites is BACKLOG #20.
 *
 * The union is safe here specifically because this is the LAST resolution tier —
 * it only ever runs after the persistent store has already missed, so a
 * cross-session name collision can only affect a name that would otherwise have
 * resolved to nothing.
 *
 * Two concurrent sessions CAN mint the same name, though, and assumption A3
 * never covered that case. The winner is the most recently minted binding, not
 * the oldest session: `bindEphemeral` already establishes "latest hint wins"
 * within a session, and iterating `_sessions` in insertion order would have
 * handed the name to whichever session connected first — the opposite rule.
 */
export function resolveEphemeral(name: string): string | null {
  const norm = normalizeName(name);
  if (!norm) return null;
  let best: EphemeralBinding | null = null;
  for (const slot of _sessions.values()) {
    const hit = slot.get(norm);
    if (hit && (!best || hit.seq > best.seq)) best = hit;
  }
  return best ? best.selector : null;
}
