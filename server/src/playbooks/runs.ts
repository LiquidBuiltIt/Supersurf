/**
 * The per-playbook run sidecar (spec §7.8) — `<name>.runs.jsonl`, append-only
 * NDJSON beside the script.
 *
 * Deliberately NOT derived from the usage-metrics trail: that trail is
 * session-scoped and gated behind `logging.usage_metrics`, which defaults off,
 * so a playbook's history would evaporate between sessions.
 *
 * `evidence` exists because the runner owns its tab and CLOSES it at exit
 * (spec §10 risk 2). A failing script destroys the page that would explain the
 * failure, so `SelectorMiss` alone captures a ranked candidate-selector list
 * before the run's tab closes; the other five error types carry no evidence.
 *
 * Every write is best-effort. A bookkeeping failure must never turn a
 * successful run into a reported failure.
 *
 * @module playbooks/runs
 */

import * as fs from 'node:fs';
import { runsFile } from './paths';
import type { PlaybookErrorType, FailureAt } from './errors';
import type { Candidate } from './candidates';

/**
 * Cap on the stored `evidence` object. A sidecar that outgrows its script helps
 * nobody — and the uncapped accessibility tree this replaces reached 766 KB for
 * a single failed selector.
 */
export const MAX_EVIDENCE_CHARS = 4000;

/** Default read window. */
const DEFAULT_LIMIT = 20;

/** Spec §7.8. */
export interface RunRecord {
  ts: number;
  params: Record<string, unknown>;
  ok: boolean;
  error?: string;
  /** Which KIND of failure — see `playbooks/errors.ts`. Absent on success. */
  type?: PlaybookErrorType;
  /** Which command threw, and its 1-based index in the run. */
  at?: FailureAt;
  /** The in-child stack, persisted for every in-child throw. */
  stack?: string;
  durationMs: number;
  profile?: string;
  caller: 'agent' | 'cli';
  /**
   * Did this run activate `meta.experiments` (Addendum B)? Recorded so a
   * failure can be attributed to the experimental path. Without it, an
   * experiment-only regression looks identical to a broken script.
   */
  experiments: boolean;
  /**
   * `SelectorMiss` only. A record written before the taxonomy carries a
   * `snapshot` string here instead; readers must tolerate both.
   */
  evidence?: { url?: string; title?: string; candidates?: Candidate[]; snapshot?: string };
}

/**
 * Shrink `evidence` until it fits the cap, dropping candidates from the TAIL.
 * The tail is the lowest-scoring end of the list, so the answer — if it is in
 * there at all — is the last thing to go. `url` and `title` always survive.
 */
function fitEvidence(ev: NonNullable<RunRecord['evidence']>): NonNullable<RunRecord['evidence']> {
  const out = { ...ev };
  if (typeof out.snapshot === 'string' && out.snapshot.length > MAX_EVIDENCE_CHARS) {
    out.snapshot = `${out.snapshot.slice(0, MAX_EVIDENCE_CHARS)}…[truncated]`;
  }
  while (JSON.stringify(out).length > MAX_EVIDENCE_CHARS && out.candidates && out.candidates.length > 0) {
    out.candidates = out.candidates.slice(0, -1);
  }
  return out;
}

/** Append one record. Never throws. */
export function appendRunRecord(name: string, rec: RunRecord): void {
  const out: RunRecord = { ...rec };
  if (out.evidence) out.evidence = fitEvidence(out.evidence);
  try {
    fs.appendFileSync(runsFile(name), `${JSON.stringify(out)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort. The run's own outcome is the thing that matters.
  }
}

/** Newest first, capped at `limit`. Malformed lines are skipped, not fatal. */
export function readRunRecords(name: string, limit = DEFAULT_LIMIT): RunRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(runsFile(name), 'utf8');
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as RunRecord);
    } catch {
      // A half-written line from a killed process. Skip it.
    }
  }
  return out;
}

/** One-line history summary for `list` / `inspect`. */
export function formatRunSummary(recs: RunRecord[]): string {
  if (recs.length === 0) return 'never run';
  const ok = recs.filter(r => r.ok).length;
  const last = recs[0];
  const kind = last.type ? `${last.type}: ` : '';
  const lastPart = last.ok ? 'last: ✓' : `last: ✗ ${kind}${last.error ?? 'unknown error'}`;
  return `${recs.length} runs, ${ok} ok — ${lastPart}`;
}
