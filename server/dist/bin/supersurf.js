#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dispatcher_1 = require("./dispatcher");
(0, dispatcher_1.dispatch)(process.argv).catch((err) => {
    console.error(`[supersurf] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
//# sourceMappingURL=supersurf.js.map