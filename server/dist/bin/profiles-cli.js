"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROFILES_USAGE = void 0;
exports.parseProfilesArgs = parseProfilesArgs;
exports.runProfilesCli = runProfilesCli;
/**
 * `supersurf profiles <cmd>` — human-facing profile management.
 *
 * ls            List profiles with running/connected state
 * open <name>   Launch a profile's Chromium, user-owned: it survives agent
 *               sessions, daemon idle-timeout/shutdown, and the orphan sweep.
 *               Close the browser window to end it.
 *
 * Talks to the daemon over the same Unix-socket IPC as MCP sessions, via a
 * throwaway session (same pattern as backend/handlers.ts profile CRUD).
 */
const daemon_spawn_1 = require("../daemon-spawn");
const daemon_client_1 = require("../daemon-client");
exports.PROFILES_USAGE = `supersurf profiles — manage browser profiles

Usage: supersurf profiles <command>

Commands:
  ls             List profiles and their state
  open <name>    Launch a profile's Chromium (user-owned: survives agent
                 sessions and daemon restarts; close the window to end it)`;
function parseProfilesArgs(argv) {
    const sub = argv[2];
    if (sub === undefined || sub === '--help' || sub === '-h')
        return { cmd: 'help' };
    if (sub === 'ls')
        return { cmd: 'ls' };
    if (sub === 'open') {
        const profile = argv[3];
        if (!profile)
            return { cmd: 'help', error: 'profiles open requires a profile name' };
        return { cmd: 'open', profile };
    }
    return { cmd: 'help', error: `unknown profiles command '${sub}'` };
}
function formatStatus(p) {
    if (p.running) {
        const conn = p.connected ? 'connected' : 'starting';
        return `running (${p.owner ?? 'daemon'}, ${conn})`;
    }
    // Not in the daemon's PID map, but an extension connection exists —
    // a browser the daemon didn't spawn (or from a previous daemon life).
    if (p.connected)
        return 'running (external, connected)';
    return 'stopped';
}
async function withCliDaemonClient(fn) {
    const port = Number(process.env.SUPERSURF_PORT) || 5555;
    await (0, daemon_spawn_1.ensureDaemon)(port);
    const client = new daemon_client_1.DaemonClient((0, daemon_spawn_1.getSockPath)(), `profiles-cli-${process.pid}`);
    try {
        await client.start();
        return await fn(client);
    }
    finally {
        await client.stop().catch(() => { });
    }
}
async function runProfilesCli(argv) {
    const parsed = parseProfilesArgs(argv);
    if (parsed.cmd === 'help') {
        if (parsed.error) {
            console.error(`supersurf: ${parsed.error}\n`);
            console.error(exports.PROFILES_USAGE);
            process.exit(1);
        }
        console.log(exports.PROFILES_USAGE);
        return;
    }
    try {
        if (parsed.cmd === 'ls') {
            const result = await withCliDaemonClient((client) => client.sendCmd('profiles.list', {}, 10000));
            const profiles = result.profiles ?? [];
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
        // open — profiles.launch waits up to 90s for the extension match; give
        // the RPC 95s so the daemon-side timeout fires first with its own error.
        const result = await withCliDaemonClient((client) => client.sendCmd('profiles.launch', { profile: parsed.profile }, 95000));
        const owner = result.owner ?? 'daemon';
        if (result.alreadyRunning) {
            console.log(`Profile '${parsed.profile}' is already running (${owner}-owned).`);
        }
        else if (owner === 'user') {
            console.log(`Profile '${parsed.profile}' opened — browser is yours until you close it.`);
        }
        else {
            console.log(`Profile '${parsed.profile}' opened, but an agent session claimed it first (${owner}-owned).`);
        }
        if (owner === 'daemon') {
            console.log('Note: daemon-owned browsers close when their agent session ends.');
        }
    }
    catch (err) {
        console.error(`supersurf: ${err?.message || String(err)}`);
        process.exit(1);
    }
}
//# sourceMappingURL=profiles-cli.js.map