/**
 * The seam between the engine and whatever opens the daemon connection.
 *
 * The engine never spawns a daemon and never imports `DaemonClient` as a value:
 * its host hands it a `DaemonLink` already connected. A version refusal is a
 * thrown `VersionMismatchError`, recognised by `code` rather than `instanceof`,
 * because the published layout carries two copies of `shared` (server's and
 * daemon's) and a class from one fails `instanceof` against the other.
 *
 * @module daemon-ipc/link
 */
import type { IExtensionTransport } from './types';
import type { DaemonClient } from './client';

export type DaemonLink = IExtensionTransport &
  Pick<
    DaemonClient,
    'version' | 'extensionConnected' | 'extensionVersionError' | 'activeSessionCount' | 'isConfigDrifted' | 'getPeerSessions'
  >;

export interface OpenLinkOptions {
  clientId: string;
  port: number;
  debug: boolean;
  experiments: string[];
  /** The version this server reports; the guard compares the daemon's version with it. */
  serverVersion: string;
  /** false: skip the version guard (profile management opens a short-lived link). */
  guardVersion: boolean;
}

/** The reply to a `daemon_status` round trip. */
export interface DaemonStatusReply {
  version?: string;
  uptimeSeconds: number;
  extensionConnected?: boolean;
  extensionBrowser?: string | null;
  [k: string]: unknown;
}

export interface VersionMismatchError extends Error {
  code: 'version_mismatch';
  daemonVersion: string | null;
  serverVersion: string;
  reason: string;
}

export function versionMismatch(daemonVersion: string | null, serverVersion: string, reason: string): VersionMismatchError {
  const err = new Error(
    `daemon/server version mismatch (daemon: ${daemonVersion ?? 'pre-3.0'}, server: ${serverVersion}). ${reason}`,
  ) as VersionMismatchError;
  err.name = 'VersionMismatchError';
  err.code = 'version_mismatch';
  err.daemonVersion = daemonVersion;
  err.serverVersion = serverVersion;
  err.reason = reason;
  return err;
}

export function isVersionMismatch(e: unknown): e is VersionMismatchError {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'version_mismatch';
}
