#!/usr/bin/env node
/**
 * `supersurf-daemon` — the coordinator entrypoint. One responsibility: hand
 * process.argv, untouched, to the daemon package's own CLI.
 *
 * Two packages declare a bin named `supersurf-daemon`: the `supersurf-daemon`
 * package itself (what `npx supersurf-daemon@latest <cmd>` resolves), and
 * `supersurf-mcp` (this file — what a global `npm i -g supersurf-mcp` puts on
 * PATH, because npm links only top-level package bins, not dependency bins).
 * Both must behave identically, so this one adds nothing at all.
 *
 * It used to splice the word daemon into argv and route through the bin command router.
 * That survived only because daemon/src/main.ts's parseArgs ignores unknown
 * tokens, and it printed a deprecation notice pointing at `supersurf daemon` —
 * a name npm will never grant us.
 */
export {};
//# sourceMappingURL=supersurf-daemon.d.ts.map