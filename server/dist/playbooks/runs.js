"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_EVIDENCE_CHARS = void 0;
exports.appendRunRecord = appendRunRecord;
exports.readRunRecords = readRunRecords;
exports.formatRunSummary = formatRunSummary;
const fs = __importStar(require("node:fs"));
const paths_1 = require("./paths");
/**
 * Cap on the stored `evidence` object. A sidecar that outgrows its script helps
 * nobody — and the uncapped accessibility tree this replaces reached 766 KB for
 * a single failed selector.
 */
exports.MAX_EVIDENCE_CHARS = 4000;
/** Default read window. */
const DEFAULT_LIMIT = 20;
/**
 * Shrink `evidence` until it fits the cap, dropping candidates from the TAIL.
 * The tail is the lowest-scoring end of the list, so the answer — if it is in
 * there at all — is the last thing to go. `url` and `title` always survive.
 */
function fitEvidence(ev) {
    const out = { ...ev };
    if (typeof out.snapshot === 'string' && out.snapshot.length > exports.MAX_EVIDENCE_CHARS) {
        out.snapshot = `${out.snapshot.slice(0, exports.MAX_EVIDENCE_CHARS)}…[truncated]`;
    }
    while (JSON.stringify(out).length > exports.MAX_EVIDENCE_CHARS && out.candidates && out.candidates.length > 0) {
        out.candidates = out.candidates.slice(0, -1);
    }
    return out;
}
/** Append one record. Never throws. */
function appendRunRecord(name, rec) {
    const out = { ...rec };
    if (out.evidence)
        out.evidence = fitEvidence(out.evidence);
    try {
        fs.appendFileSync((0, paths_1.runsFile)(name), `${JSON.stringify(out)}\n`, { mode: 0o600 });
    }
    catch {
        // Best-effort. The run's own outcome is the thing that matters.
    }
}
/** Newest first, capped at `limit`. Malformed lines are skipped, not fatal. */
function readRunRecords(name, limit = DEFAULT_LIMIT) {
    let raw;
    try {
        raw = fs.readFileSync((0, paths_1.runsFile)(name), 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i].trim();
        if (!line)
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // A half-written line from a killed process. Skip it.
        }
    }
    return out;
}
/** One-line history summary for `list` / `inspect`. */
function formatRunSummary(recs) {
    if (recs.length === 0)
        return 'never run';
    const ok = recs.filter(r => r.ok).length;
    const last = recs[0];
    const kind = last.type ? `${last.type}: ` : '';
    const lastPart = last.ok ? 'last: ✓' : `last: ✗ ${kind}${last.error ?? 'unknown error'}`;
    return `${recs.length} runs, ${ok} ok — ${lastPart}`;
}
//# sourceMappingURL=runs.js.map