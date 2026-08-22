/**
 * Types for the playbooks feature — the action trail and saved playbooks.
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

/** One frozen step of a saved playbook. */
export interface PlaybookStep {
  /** MCP tool to invoke, e.g. `browser_interact`, `browser_navigate`. */
  tool: string;
  /** Action verb for interact steps; equals `tool` otherwise. */
  type: string;
  /** Params to re-issue verbatim. */
  params: Record<string, unknown>;
  /** URL this step was recorded on. Step 1's value is the run's start point. */
  url?: string;
  /** The trail id this step was frozen from, for provenance in `show`. */
  sourceId: number;
}

/** A saved playbook, one per file on disk. */
export interface Playbook {
  name: string;
  purpose: string;
  steps: PlaybookStep[];
  createdAt: number;
  /** Schema version, so a later format change can migrate rather than crash. */
  version: 1;
  /** Managed profile this playbook was created under, when the session was
   *  profile-bound. Absent for unmanaged sessions. Drives `run`'s implicit
   *  profile resolution when no explicit `profile` arg is given. */
  profile?: string;
}
