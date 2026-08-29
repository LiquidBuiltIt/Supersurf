import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setPlaybooksDirForTests, runsFile } from '../src/playbooks/paths';
import {
  appendRunRecord, readRunRecords, formatRunSummary,
  MAX_EVIDENCE_CHARS, type RunRecord,
} from '../src/playbooks/runs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-runs-'));
  setPlaybooksDirForTests(dir);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return { ts: 1000, params: { q: 'x' }, ok: true, durationMs: 42, caller: 'agent', experiments: false, ...over };
}

describe('appendRunRecord', () => {
  it('writes one JSON object per line to <name>.runs.jsonl', () => {
    appendRunRecord('post_tweet', rec());
    appendRunRecord('post_tweet', rec({ ts: 2000, ok: false, error: 'boom' }));
    const lines = fs.readFileSync(runsFile('post_tweet'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).ts).toBe(1000);
    expect(JSON.parse(lines[1]).error).toBe('boom');
  });

  it('creates the file with 0600 permissions', () => {
    appendRunRecord('post_tweet', rec());
    const mode = fs.statSync(runsFile('post_tweet')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('truncates oversized evidence instead of unbounded growth', () => {
    appendRunRecord('post_tweet', rec({ ok: false, evidence: { snapshot: 'x'.repeat(MAX_EVIDENCE_CHARS + 500) } }));
    const written = readRunRecords('post_tweet')[0];
    expect(written.evidence!.snapshot!.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS + 20);
    expect(written.evidence!.snapshot!.endsWith('…[truncated]')).toBe(true);
  });

  it('never throws when the directory is unwritable', () => {
    setPlaybooksDirForTests(path.join(dir, 'does', 'not', 'exist'));
    expect(() => appendRunRecord('post_tweet', rec())).not.toThrow();
  });
});

describe('readRunRecords', () => {
  it('returns the newest records first, capped at the limit', () => {
    for (let i = 1; i <= 5; i++) appendRunRecord('p', rec({ ts: i }));
    expect(readRunRecords('p', 3).map(r => r.ts)).toEqual([5, 4, 3]);
  });

  it('skips malformed lines rather than failing the read', () => {
    appendRunRecord('p', rec({ ts: 1 }));
    fs.appendFileSync(runsFile('p'), 'not json\n');
    appendRunRecord('p', rec({ ts: 2 }));
    expect(readRunRecords('p').map(r => r.ts)).toEqual([2, 1]);
  });

  it('returns an empty array when there is no sidecar', () => {
    expect(readRunRecords('never_run')).toEqual([]);
  });

  it('round-trips the experiments flag so a failure is attributable', () => {
    appendRunRecord('p', rec({ ok: false, error: 'boom', experiments: true }));
    expect(readRunRecords('p')[0].experiments).toBe(true);
  });
});

describe('formatRunSummary', () => {
  it('reports "never run" for an empty history', () => {
    expect(formatRunSummary([])).toBe('never run');
  });

  it('reports the pass count and the last outcome', () => {
    const out = formatRunSummary([
      rec({ ts: 3000, ok: false, error: 'selector gone' }),
      rec({ ts: 2000, ok: true }),
      rec({ ts: 1000, ok: true }),
    ]);
    expect(out).toContain('3 runs');
    expect(out).toContain('2 ok');
    expect(out).toContain('last: ✗ selector gone');
  });
});
