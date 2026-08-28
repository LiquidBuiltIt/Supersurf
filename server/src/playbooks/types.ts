/**
 * Types for the in-memory action trail behind the `playbooks history` action.
 *
 * The `Playbook`/`PlaybookStep` shapes that used to live here described the
 * JSON on-disk format. A playbook is a JavaScript file now — its shape is the
 * file — so nothing here describes disk any more.
 *
 * @module playbooks/types
 */

/** Outcome of a single recorded action or tool call. */
export type TrailOutcome = 'ok' | 'warn' | 'error';

/** What a caller hands to `actionTrail.record()`. The id is minted, not supplied. */
export interface TrailInput {
  /** MCP tool name, e.g. `browser_interact`, `browser_navigate`. */
  tool: string;
  /** Action verb for interact actions (`click`, `type`), else the tool name again. */
  type: string;
  outcome: TrailOutcome;
  /** Human-readable result line body, truncated on store. */
  message: string;
  /** The exact params needed to re-issue this action during a run. */
  params: Record<string, unknown>;
  /** URL the action ran against, when known. */
  url?: string;
}

/** A recorded entry, as retained in memory. */
export interface TrailEntry extends TrailInput {
  id: number;
  at: number;
}
