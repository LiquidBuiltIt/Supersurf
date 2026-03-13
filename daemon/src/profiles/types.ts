/**
 * Type definitions for profile management.
 *
 * @module profiles/types
 */

import type { WebSocket } from 'ws';

/** Persisted profile configuration stored in supersurf.json. */
export interface ProfileConfig {
  name: string;
  created: string;
  initialized: boolean;
  experiments?: Record<string, boolean>;
}

/** Runtime profile entry combining config with process state. */
export interface ProfileEntry {
  name: string;
  config: ProfileConfig;
  pid: number | null;
}

/** A single line in the managed-pids.jsonl crash-recovery log. */
export interface PidLogEntry {
  action: 'spawn' | 'kill';
  profile: string;
  pid: number;
  ts: string;
}

/** A WebSocket connection from an extension instance sitting in the matchmaker pool. */
export interface PooledConnection {
  ws: WebSocket;
  profile: string | null;
  browser: string;
  buildTimestamp: string | null;
  pingInterval: ReturnType<typeof setInterval> | null;
  inflight: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
}

/** An agent waiting for a matching extension connection. */
export interface PendingMatch {
  profile: string | null;
  resolve: (conn: PooledConnection) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  retries: number;
}

/** Check if a JSON-RPC method is a profile IPC message. */
export function isProfileMethod(method: string): boolean {
  return method === 'profiles.create'
    || method === 'profiles.list'
    || method === 'profiles.delete'
    || method === 'profiles.connect';
}
