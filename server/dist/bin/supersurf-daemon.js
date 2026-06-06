#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dispatcher_1 = require("./dispatcher");
console.error('[supersurf-daemon] Deprecated: use `supersurf daemon` instead. This alias will be removed in a future release.');
const rewritten = [process.argv[0], process.argv[1], 'daemon', ...process.argv.slice(2)];
(0, dispatcher_1.dispatch)(rewritten).catch((err) => {
    console.error(`[supersurf-daemon] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
//# sourceMappingURL=supersurf-daemon.js.map