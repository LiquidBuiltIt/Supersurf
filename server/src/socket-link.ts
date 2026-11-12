/**
 * The server's `EngineHost.openLink`: ensure the daemon runs, connect a
 * `DaemonClient`, and enforce the daemon/server version guard. A verbatim port
 * of the block that lived in `backend/handlers.ts:onConnect`; the only change is
 * that a refusal is thrown as a `VersionMismatchError` instead of returned.
 *
 * @module socket-link
 */
import { DaemonClient, versionMismatch, createLog, type DaemonLink, type OpenLinkOptions } from 'shared';
import { ensureDaemon, stopDaemon, getSockPath } from './daemon-spawn';

const log = createLog('[Conn]');

export async function openSocketLink(opts: OpenLinkOptions): Promise<DaemonLink> {
  log('Ensuring daemon is running...');
  await ensureDaemon(opts.port, opts.debug, opts.experiments);

  const sockPath = getSockPath();
  let client = new DaemonClient(sockPath, opts.clientId);
  try {
    await client.start();
  } catch (e) {
    // The unguarded caller (profile management) always stopped its temporary client; keep that.
    if (!opts.guardVersion) await client.stop().catch(() => {});
    throw e;
  }
  if (!opts.guardVersion) return client;

  // Refuse to attach to a daemon of a different generation. ensureDaemon
  // only checks PID liveness, so a stale daemon from a previous package
  // version survives upgrades: restart it once with the bundled daemon
  // (owner decision 2026-08-25: daemon lifecycle is server-owned infra).
  let daemonVersion = client.version;
  const serverVersion = opts.serverVersion;
  if (daemonVersion !== serverVersion) {
    // Don't SIGTERM a daemon another session is mid-workflow on.
    // `activeSessionCount` includes this session's own ack, so >1 means
    // someone else is genuinely live on it. Absent (an old daemon) must fall
    // back to the restart, or this guard bricks the upgrade path it protects.
    const sessionCount = client.activeSessionCount;
    if (sessionCount !== null && sessionCount > 1) {
      await client.stop().catch(() => {});
      const otherSessions = sessionCount - 1;
      throw versionMismatch(
        daemonVersion,
        serverVersion,
        `The daemon was NOT restarted because ${otherSessions} other session` +
          `${otherSessions === 1 ? '' : 's'} ${otherSessions === 1 ? 'is' : 'are'} ` +
          'currently active on it, and a restart would disconnect them.',
      );
    }

    log(`Daemon version mismatch (daemon: ${daemonVersion ?? 'pre-3.0'}, server: ${serverVersion}) — restarting daemon`);
    await client.stop().catch(() => {});
    await stopDaemon();
    await ensureDaemon(opts.port, opts.debug, opts.experiments);
    client = new DaemonClient(sockPath, opts.clientId);
    await client.start();
    daemonVersion = client.version;
  }
  if (daemonVersion !== serverVersion) {
    await client.stop().catch(() => {});
    throw versionMismatch(daemonVersion, serverVersion, 'Something outside this server keeps respawning it.');
  }
  return client;
}
