"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.daemonCommand = daemonCommand;
/**
 * The one place a user-facing daemon command string is built.
 *
 * The bug this exists to prevent (BACKLOG #34): a printed `supersurf-daemon
 * restart` only resolves on a machine where someone ran `npm i -g
 * supersurf-daemon`. No documented install path does that — the server
 * auto-spawns the daemon out of its own `node_modules` — so the hint was a
 * `command not found` for every normal reader. `server/src/bridge.ts` was
 * corrected in BACKLOG #25; the two daemon-side copies were outside that
 * plan's file list and survived.
 *
 * A single builder, rather than two corrected literals, because the correct
 * string is about to change again: when the compiled binary ships (BACKLOG
 * #38) this becomes `supersurf daemon <sub>`. That is one edit here instead
 * of a third hunt through printed output.
 */
function daemonCommand(subcommand) {
    return `npx supersurf-daemon@latest ${subcommand}`;
}
//# sourceMappingURL=index.js.map