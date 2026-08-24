"use strict";
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
exports.HELP_TEXT = void 0;
exports.pickTarget = pickTarget;
exports.dispatch = dispatch;
const shared_1 = require("../shared");
const { version: VERSION } = require('../../package.json');
exports.HELP_TEXT = `supersurf — MCP browser automation for AI agents

Usage: supersurf <command> [options]

Commands:
  mcp       Start the MCP server over stdio (the agent entrypoint)
  daemon    Manage the coordinator daemon: start | stop | restart | status | observe
  profiles  Manage browser profiles: ls | open <name> | create <name> | rm <name> | rename <old> <new>
  export    Bundle usage-metrics logs into a .zip in the current directory
  playbook  Manage saved playbooks: ls | show | edit | rm | export | import

Examples:
  npx supersurf-mcp@latest mcp
  supersurf daemon status
  supersurf profiles open dev
  supersurf export
  supersurf playbook ls`;
function pickTarget(argv) {
    const subcommand = argv[2];
    if (subcommand === 'mcp' ||
        subcommand === 'daemon' ||
        subcommand === 'profiles' ||
        subcommand === 'export' ||
        subcommand === 'playbook') {
        return {
            target: subcommand,
            remainingArgv: [...argv.slice(0, 2), ...argv.slice(3)],
        };
    }
    // No recognized subcommand — intentionally do NOT default to the MCP
    // server. A bare invocation (or --help) prints usage; an unrecognized
    // command is a usage error. This keeps the entrypoint explicit so a
    // misconfigured caller gets help instead of a silently-hanging stdio server.
    return { target: 'help', remainingArgv: argv };
}
async function dispatch(argv) {
    const { target, remainingArgv } = pickTarget(argv);
    // `mcp` (JSON-RPC over stdout — see cli.ts) and `daemon` (its own CLI in
    // daemon/src/main.ts, imported below) each own their own stderr-only/human
    // notice check. Every other subcommand here — profiles, export, help/usage
    // errors — is plain human-facing stdio, so the notice is safe on stdout.
    if (target !== 'mcp' && target !== 'daemon') {
        const versionCheck = (0, shared_1.checkAndTouchVersionState)(VERSION);
        if (versionCheck.shouldNotify) {
            console.log(shared_1.UPGRADE_NOTICE_MESSAGE);
        }
    }
    if (target === 'help') {
        const sub = argv[2];
        if (sub === undefined || sub === '--help' || sub === '-h') {
            // Bare `supersurf` or an explicit help flag → usage on stdout, exit 0.
            console.log(exports.HELP_TEXT);
            return;
        }
        // Unrecognized command → usage on stderr, non-zero exit.
        console.error(`supersurf: unknown command '${sub}'\n`);
        console.error(exports.HELP_TEXT);
        process.exit(1);
    }
    process.argv = remainingArgv;
    if (target === 'mcp') {
        await Promise.resolve().then(() => __importStar(require('../cli')));
    }
    else if (target === 'daemon') {
        // The daemon ships as a SEPARATE package (`supersurf-daemon`). Resolve it
        // via the package name — exactly how daemon-spawn.ts does — which works in
        // both local dev (workspace symlink) and a published install. The old
        // '../daemon/main' relative path assumed a bundle-copy into server/dist
        // that was never wired into any build script, so this entry crashed with
        // MODULE_NOT_FOUND and the daemon CLI (status|stop|restart|observe) was
        // completely dead. Importing the resolved entry runs its CLI against the
        // process.argv we just set above.
        const { resolveDaemonEntry } = await Promise.resolve().then(() => __importStar(require('../daemon-spawn')));
        await Promise.resolve(`${resolveDaemonEntry()}`).then(s => __importStar(require(s)));
    }
    else if (target === 'profiles') {
        const { runProfilesCli } = await Promise.resolve().then(() => __importStar(require('./profiles-cli')));
        await runProfilesCli(remainingArgv);
    }
    else if (target === 'export') {
        const { runExportProgram } = await Promise.resolve().then(() => __importStar(require('./export')));
        const code = await runExportProgram(remainingArgv);
        process.exit(code);
    }
    else if (target === 'playbook') {
        const { runPlaybookProgram } = await Promise.resolve().then(() => __importStar(require('./playbook-cli')));
        await runPlaybookProgram(remainingArgv);
    }
    else {
        // Unreachable until `creds` is re-listed in pickTarget — kept intentionally
        // (delisting is reversible; the keychain CLI is dead-but-ready, not deleted).
        const credsModule = await Promise.resolve().then(() => __importStar(require('./creds')));
        await credsModule.runCredsProgram(remainingArgv);
    }
}
//# sourceMappingURL=dispatcher.js.map