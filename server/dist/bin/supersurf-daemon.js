#!/usr/bin/env node
"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const daemon_spawn_1 = require("../daemon-spawn");
Promise.resolve(`${(0, daemon_spawn_1.resolveDaemonEntry)()}`).then(s => __importStar(require(s))).catch((err) => {
    console.error(`[supersurf-daemon] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
//# sourceMappingURL=supersurf-daemon.js.map