/**
 * What the engine needs from the process that hosts it. The engine imports no
 * `daemon-spawn`, `backend-config` or `package.json`; the host supplies them.
 *
 * @module host
 */
import type { DaemonLink, OpenLinkOptions, DaemonStatusReply } from 'shared';
import type { BackendConfig } from './backend/types';

export interface EngineHost {
  /** The version of the package that hosts the engine (metrics logs, run config). */
  readonly packageVersion: string;
  /** Spawn the daemon if needed, connect, and (if `guardVersion`) refuse a mismatched daemon by throwing a `VersionMismatchError`. */
  openLink(opts: OpenLinkOptions): Promise<DaemonLink>;
  /** One `daemon_status` round trip; null when the daemon is unreachable. */
  queryDaemonStatus(): Promise<DaemonStatusReply | null>;
  /** A fresh BackendConfig for a playbook run's own session. */
  runConfig(): BackendConfig;
  /** One env var for `secure_fill`; absent: the engine reads `process.env`. A worker host asks the shim that owns the session. */
  envGet?(name: string): Promise<string | undefined>;
  /** The credential names `secure_fill list` shows; absent: the names loaded from `.env`. */
  envKeys?(): Promise<string[]>;
}
