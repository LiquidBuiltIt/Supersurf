/**
 * Shared types for the daemon package.
 *
 * @module types
 */

/** Where a session's outbound messages go. A socket sink serializes; an in-process sink takes the object as is. */
export interface SessionSink {
  send(msg: object): void;
  end(): void;
}

/** State tracked per connected MCP session. */
export interface DaemonSession {
  sessionId: string;
  sink: SessionSink;
  ownedTabs: Set<number>;
  /** Tabs this session created (not claimed) — closed when the session ends. */
  createdTabs: Set<number>;
  attachedTabId: number | null;
  groupId: number | null;
  profileId: string | null;
}

/** A request waiting in the round-robin scheduler queue. */
export interface QueuedRequest {
  sessionId: string;
  method: string;
  params: Record<string, unknown>;
  timeout: number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** Pending promise callbacks for an in-flight request to the extension. */
export interface InflightRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}
