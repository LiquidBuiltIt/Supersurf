/**
 * `supersurf profiles <cmd>` — human-facing profile management.
 *
 * ls                  List profiles with running/connected state
 * open <name>         Launch a profile's Chromium, user-owned: it survives
 *                     agent sessions, daemon idle-timeout/shutdown, and the
 *                     orphan sweep. Close the browser window to end it.
 * create <name>       Create a new managed profile.
 * rm <name>           Remove a profile. Refuses if it's running or bound to
 *                     an active session — reuses ProfileRegistry.delete()'s
 *                     existing failsafe, doesn't reimplement it here.
 * rename <old> <new>  Rename a profile. Same failsafe as rm.
 *
 * Talks to the daemon over the same Unix-socket IPC as MCP sessions, via a
 * throwaway session (same pattern as backend/handlers.ts profile CRUD).
 */
import { ensureDaemon, getSockPath } from '../daemon-spawn';
import { DaemonClient } from '../daemon-client';

export const PROFILES_USAGE = `supersurf profiles — manage browser profiles

Usage: supersurf profiles <command>

Commands:
  ls                   List profiles and their state
  open <name>          Launch a profile's Chromium (user-owned: survives agent
                        sessions and daemon restarts; close the window to end it)
  create <name>        Create a new managed profile
  rm <name>            Remove a profile (refuses if running or session-bound)
  rename <old> <new>   Rename a profile (refuses if running or session-bound)`;

export type ProfilesCommand =
  | { cmd: 'ls' }
  | { cmd: 'open'; profile: string }
  | { cmd: 'create'; name: string }
  | { cmd: 'rm'; name: string }
  | { cmd: 'rename'; oldName: string; newName: string }
  | { cmd: 'help'; error?: string };

export function parseProfilesArgs(argv: string[]): ProfilesCommand {
  const sub = argv[2];
  if (sub === undefined || sub === '--help' || sub === '-h') return { cmd: 'help' };
  if (sub === 'ls') return { cmd: 'ls' };
  if (sub === 'open') {
    const profile = argv[3];
    if (!profile) return { cmd: 'help', error: 'profiles open requires a profile name' };
    return { cmd: 'open', profile };
  }
  if (sub === 'create') {
    const name = argv[3];
    if (!name) return { cmd: 'help', error: 'profiles create requires a profile name' };
    return { cmd: 'create', name };
  }
  if (sub === 'rm' || sub === 'delete') {
    const name = argv[3];
    if (!name) return { cmd: 'help', error: 'profiles rm requires a profile name' };
    return { cmd: 'rm', name };
  }
  if (sub === 'rename') {
    const oldName = argv[3];
    const newName = argv[4];
    if (!oldName || !newName) return { cmd: 'help', error: 'profiles rename requires <old> and <new> names' };
    return { cmd: 'rename', oldName, newName };
  }
  return { cmd: 'help', error: `unknown profiles command '${sub}'` };
}

interface ListedProfile {
  name: string;
  created: string;
  running: boolean;
  owner: 'daemon' | 'user' | null;
  connected: boolean;
}

function formatStatus(p: ListedProfile): string {
  if (p.running) {
    const conn = p.connected ? 'connected' : 'starting';
    return `running (${p.owner ?? 'daemon'}, ${conn})`;
  }
  // Not in the daemon's PID map, but an extension connection exists —
  // a browser the daemon didn't spawn (or from a previous daemon life).
  if (p.connected) return 'running (external, connected)';
  return 'stopped';
}

async function withCliDaemonClient<T>(fn: (client: DaemonClient) => Promise<T>): Promise<T> {
  const port = Number(process.env.SUPERSURF_PORT) || 5555;
  await ensureDaemon(port);
  const client = new DaemonClient(getSockPath(), `profiles-cli-${process.pid}`);
  try {
    await client.start();
    return await fn(client);
  } finally {
    await client.stop().catch(() => {});
  }
}

export async function runProfilesCli(argv: string[]): Promise<void> {
  const parsed = parseProfilesArgs(argv);

  if (parsed.cmd === 'help') {
    if (parsed.error) {
      console.error(`supersurf: ${parsed.error}\n`);
      console.error(PROFILES_USAGE);
      process.exit(1);
    }
    console.log(PROFILES_USAGE);
    return;
  }

  try {
    if (parsed.cmd === 'ls') {
      const result = await withCliDaemonClient((client) =>
        client.sendCmd('profiles.list', {}, 10000),
      );
      const profiles: ListedProfile[] = result.profiles ?? [];
      if (profiles.length === 0) {
        console.log('No profiles. Create one via the profile_create MCP tool.');
        return;
      }
      const nameW = Math.max(4, ...profiles.map((p) => p.name.length)) + 2;
      console.log(`${'NAME'.padEnd(nameW)}${'STATUS'.padEnd(30)}CREATED`);
      for (const p of profiles) {
        console.log(`${p.name.padEnd(nameW)}${formatStatus(p).padEnd(30)}${p.created}`);
      }
      return;
    }

    if (parsed.cmd === 'open') {
      // profiles.launch waits up to 90s for the extension match; give
      // the RPC 95s so the daemon-side timeout fires first with its own error.
      const result = await withCliDaemonClient((client) =>
        client.sendCmd('profiles.launch', { profile: parsed.profile }, 95000),
      );
      const owner = result.owner ?? 'daemon';
      if (result.alreadyRunning) {
        console.log(`Profile '${parsed.profile}' is already running (${owner}-owned).`);
      } else if (owner === 'user') {
        console.log(`Profile '${parsed.profile}' opened — browser is yours until you close it.`);
      } else {
        console.log(`Profile '${parsed.profile}' opened, but an agent session claimed it first (${owner}-owned).`);
      }
      if (owner === 'daemon') {
        console.log('Note: daemon-owned browsers close when their agent session ends.');
      }
      return;
    }

    if (parsed.cmd === 'create') {
      const result = await withCliDaemonClient((client) =>
        client.sendCmd('profiles.create', { name: parsed.name }, 10000),
      );
      console.log(`Profile '${result?.profile?.name ?? parsed.name}' created.`);
      return;
    }

    if (parsed.cmd === 'rm') {
      // Routes through ProfileRegistry.delete() on the daemon side, which
      // already refuses while active sessions are connected or a user-owned
      // browser is running — no client-side reimplementation of that check.
      await withCliDaemonClient((client) =>
        client.sendCmd('profiles.delete', { name: parsed.name }, 10000),
      );
      console.log(`Profile '${parsed.name}' removed.`);
      return;
    }

    // rename — routes through ProfileRegistry.rename(), which refuses while
    // active sessions are connected or the profile's Chromium is running.
    await withCliDaemonClient((client) =>
      client.sendCmd('profiles.rename', { name: parsed.oldName, newName: parsed.newName }, 10000),
    );
    console.log(`Profile '${parsed.oldName}' renamed to '${parsed.newName}'.`);
  } catch (err: any) {
    console.error(`supersurf: ${err?.message || String(err)}`);
    process.exit(1);
  }
}
