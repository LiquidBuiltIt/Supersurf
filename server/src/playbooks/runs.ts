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
 * failure, so the snapshot is taken on the throw, before teardown.
 *
 * Every write is best-effort. A bookkeeping failure must never turn a
 * successful run into a reported failure.
 *
 * @module playbooks/runs
 */

import * as fs from 'node:fs';
import { runsFile } from './paths';

/** Cap on a stored snapshot. A sidecar that outgrows its script helps nobody. */
export const MAX_EVIDENCE_CHARS = 4000;

/** Default read window. */
const DEFAULT_LIMIT = 20;

/** Spec §7.8. */
export interface RunRecord {
  ts: number;
  params: Record<string, unknown>;
  ok: boolean;
  error?: string;
  durationMs: number;
  profile?: string;
  caller: 'agent' | 'cli';
  /**
   * Did this run activate `meta.experiments` (Addendum B)? Recorded so a
   * failure can be attributed to the experimental path. Without it, an
   * experiment-only regression looks identical to a broken script.
   */
  experiments: boolean;
  evidence?: { snapshot?: string };
}

function truncate(s: string): string {
  return s.length <= MAX_EVIDENCE_CHARS ? s : `${s.slice(0, MAX_EVIDENCE_CHARS)}…[truncated]`;
}

/** Append one record. Never throws. */
export function appendRunRecord(name: string, rec: RunRecord): void {
  const out: RunRecord = { ...rec };
  if (out.evidence?.snapshot) {
    out.evidence = { ...out.evidence, snapshot: truncate(out.evidence.snapshot) };
  }
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
  const lastPart = last.ok ? 'last: ✓' : `last: ✗ ${last.error ?? 'unknown error'}`;
  return `${recs.length} runs, ${ok} ok — ${lastPart}`;
}
