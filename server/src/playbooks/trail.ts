/**
 * ActionTrail — the in-memory record of every browser action this MCP session
 * performed, each with a monotonic id the agent can cite when building a playbook.
 *
 * LIFETIME: module-level singleton, so it lives exactly as long as the server
 * process. One server process serves exactly one MCP client for its whole life
 * (`cli.ts` connects a single StdioServerTransport with no accept loop), so
 * module scope IS session scope. Ids therefore never reset mid-conversation —
 * an id the agent saw an hour ago still means the same action.
 *
 * NOT the usage-metrics logger. That trail is gated by `logging.usage_metrics`
 * (default off) and redacts `value`, which would reconstruct a `select_option`
 * step as `[REDACTED]`. This one is always on and keeps params intact, because
 * `run` has to re-issue them.
 *
 * @module playbooks/trail
 */

import type { TrailEntry, TrailInput } from './types';

/** Retained entries. At ~100 bytes each this caps the trail near 1 MB. */
const MAX_ENTRIES = 10_000;

/** Message cap. Long messages are display strings, not data — truncation is safe. */
const MAX_MESSAGE = 200;

class ActionTrail {
  private _nextId = 1;
  private _entries: TrailEntry[] = [];

  /**
   * Record an action and return its freshly minted id.
   *
   * The id counter is independent of the retention buffer: evicting old entries
   * never rewinds the counter, so a cited-but-evicted id resolves to "not found"
   * rather than silently hitting a different action.
   */
  record(input: TrailInput): number {
    const id = this._nextId++;
    const message = input.message.length > MAX_MESSAGE
      ? input.message.slice(0, MAX_MESSAGE - 1) + '…'
      : input.message;
    this._entries.push({ ...input, message, id, at: Date.now() });
    if (this._entries.length > MAX_ENTRIES) {
      this._entries.splice(0, this._entries.length - MAX_ENTRIES);
    }
    return id;
  }

  /** Look up one entry by id. Undefined when unknown or evicted. */
  get(id: number): TrailEntry | undefined {
    return this._entries.find(e => e.id === id);
  }

  /**
   * Most-recent-first window, returned in ascending id order for display.
   * `offset` pages backwards: offset 0 is the newest `limit` entries.
   */
  tail(limit: number, offset = 0): { entries: TrailEntry[]; total: number } {
    const total = this._entries.length;
    const end = Math.max(0, total - offset);
    const start = Math.max(0, end - limit);
    return { entries: this._entries.slice(start, end), total };
  }

  size(): number {
    return this._entries.length;
  }

  /** Test-only. Do not call from production code. */
  _resetForTest(): void {
    this._nextId = 1;
    this._entries = [];
  }
}

export const actionTrail = new ActionTrail();
