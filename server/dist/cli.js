#!/usr/bin/env node
"use strict";
/**
 * SuperSurf MCP Server — CLI entry point.
 *
 * Handles three execution modes:
 *   1. **MCP mode** (default) — stdio transport, full MCP protocol
 *   2. **Debug wrapper mode** — parent process that spawns a child and restarts
 *      it on exit code 42 (hot reload), piping stdin/stdout through PassThrough streams
 *   3. **Script mode** — lightweight JSON-RPC 2.0 over stdio, no MCP overhead
 *
 * In debug mode, the process forks: the wrapper owns stdio streams and the child
 * runs `--child` to handle MCP requests. This keeps hot reload transparent to
 * the MCP client.
 *
 * @module cli
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
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const commander_1 = require("commander");
const child_process_1 = require("child_process");
const stream_1 = require("stream");
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const backend_1 = require("./backend");
const logger_1 = require("./logger");
const stdio_1 = require("./stdio");
const dotenv_1 = require("./dotenv");
const shared_1 = require("./shared");
const { version: VERSION } = require('../package.json');
/** Parse --debug value into a DebugMode. */
function parseDebugMode(value) {
    if (value === 'no_truncate')
        return 'no_truncate';
    if (value)
        return 'truncate';
    return false;
}
/** Translate CLI options into a PartialConfig slice for ConfigService. */
function cliToPartial(options) {
    const out = {};
    if (options.port !== undefined)
        out.daemon = { port: Number(options.port) };
    if (options.debug === true || options.debug === 'no_truncate' || (typeof options.debug === 'string' && options.debug && options.debug !== 'false')) {
        out.logging = { debug: options.debug === 'no_truncate' ? 'no_truncate' : 'truncate' };
    }
    if (options.disableSecureEval)
        out.security = { secure_eval: false };
    return out;
}
/** Build a ConfigService merging CLI + env + file inputs. */
function buildConfig(options) {
    const configPath = process.env.SUPERSURF_CONFIG_FILE
        || path.join(os.homedir(), '.supersurf', 'config.json');
    const { config: fileCfg, warnings: fileWarn } = (0, shared_1.loadJsonConfig)(configPath);
    const { config: envCfg, warnings: envWarn } = (0, shared_1.loadEnvConfig)(process.env);
    for (const w of [...fileWarn, ...envWarn])
        console.error(`[server] ${w}`);
    return new shared_1.ConfigService({
        cli: cliToPartial(options),
        env: envCfg,
        file: fileCfg,
        onWarn: (m) => console.error(`[server] ${m}`),
    });
}
/** Build a BackendConfig from a resolved ConfigService snapshot. */
function backendConfigFrom(configService) {
    const c = configService.get();
    return {
        debug: !!c.logging.debug,
        port: c.daemon.port,
        server: {
            name: 'SuperSurf',
            version: VERSION,
        },
        enabledExperiments: Object.entries(c.experiments)
            .filter(([k, v]) => v && k !== 'profiles')
            .map(([k]) => k),
        configService,
    };
}
/**
 * Debug wrapper mode. Spawns the server as a child process and monitors its exit code.
 * Exit code 42 triggers a restart (hot reload); any other code terminates the wrapper.
 * stdin/stdout are piped through PassThrough streams so the MCP client sees a
 * single continuous connection across reloads.
 */
function runAsWrapper() {
    console.error('[Wrapper] Starting in wrapper mode with auto-reload enabled');
    const inputBuffer = new stream_1.PassThrough();
    const outputBuffer = new stream_1.PassThrough();
    process.stdin.pipe(inputBuffer);
    outputBuffer.pipe(process.stdout);
    function spawnChild() {
        console.error('[Wrapper] Starting MCP server...');
        // Strip --debug from child args (wrapper already set debug context) and add --child flag
        const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--debug'));
        args.push('--child');
        const child = (0, child_process_1.spawn)(process.execPath, [__filename, ...args], {
            stdio: ['pipe', 'pipe', 'inherit'],
        });
        inputBuffer.pipe(child.stdin);
        child.stdout.pipe(outputBuffer, { end: false });
        child.on('exit', (code, signal) => {
            console.error(`[Wrapper] Child exited (code=${code}, signal=${signal})`);
            inputBuffer.unpipe(child.stdin);
            child.stdout.unpipe(outputBuffer);
            if (code === 42) {
                console.error('[Wrapper] Reload requested, restarting...');
                setTimeout(() => spawnChild(), 100);
            }
            else {
                console.error('[Wrapper] Server terminated, shutting down');
                process.exit(code || 0);
            }
        });
        child.on('error', (err) => {
            console.error(`[Wrapper] Child error: ${err.message}`);
            process.exit(1);
        });
        process.on('SIGTERM', () => {
            child.kill();
            process.exit(0);
        });
        process.on('SIGINT', () => {
            child.kill();
            process.exit(0);
        });
    }
    spawnChild();
}
/**
 * Registers signal/close handlers that properly tear down the WebSocket server
 * before exiting. Force-exits after 5s if graceful shutdown hangs.
 */
function setupExitWatchdog(backend, server) {
    let cleanupDone = false;
    const cleanup = async () => {
        if (cleanupDone)
            return;
        cleanupDone = true;
        if (global.DEBUG_MODE) {
            console.error('[cli] Cleanup initiated — releasing port');
        }
        // Force-exit after 5s if graceful shutdown hangs
        const forceExit = setTimeout(() => {
            if (global.DEBUG_MODE) {
                console.error('[cli] Forcing exit after timeout');
            }
            process.exit(0);
        }, 5000);
        forceExit.unref();
        try {
            await backend.serverClosed();
            await server.close();
        }
        catch {
            // Best-effort — force-exit timer will catch us
        }
        process.exit(0);
    };
    process.stdin.on('close', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}
// No server-side idle timeout — connection stays alive until the agent
// disconnects or the daemon shuts itself down (10-min idle after all sessions gone).
/** Boot the MCP server: init logging, create ConnectionManager, wire MCP handlers, start stdio transport. */
async function main(options) {
    // Load .env from cwd before anything reads process.env
    (0, dotenv_1.loadDotenv)(process.cwd());
    const configService = buildConfig(options);
    const debugSetting = configService.get().logging.debug;
    const debugMode = debugSetting === 'no_truncate'
        ? 'no_truncate'
        : debugSetting
            ? 'truncate'
            : false;
    global.DEBUG_MODE = !!debugMode;
    const reg = (0, logger_1.getRegistry)();
    reg.debugMode = debugMode;
    const logger = (0, logger_1.getLogger)(options.logFile);
    if (debugMode) {
        logger.enable();
        logger.log('[cli] Starting SuperSurf MCP server in PASSIVE mode');
        logger.log('[cli] Version:', VERSION);
        logger.log('[cli] Debug mode:', debugMode);
        logger.log('[cli] Log file:', logger.logFilePath);
        if (options.port) {
            logger.log('[cli] Custom port:', options.port);
        }
    }
    const config = backendConfigFrom(configService);
    const backend = new backend_1.ConnectionManager(config);
    if (global.DEBUG_MODE) {
        console.error(`[cli] Creating MCP Server v${VERSION}...`);
    }
    const server = new index_js_1.Server({ name: config.server.name, version: config.server.version }, { capabilities: { tools: {}, logging: {} } });
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
        const tools = await backend.listTools();
        return { tools };
    });
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        return await backend.callTool(name, args ?? {});
    });
    await backend.initialize(server, {});
    // Wire up exit watchdog now that backend + server exist
    setupExitWatchdog(backend, server);
    if (global.DEBUG_MODE) {
        console.error('[cli] Starting stdio transport...');
    }
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    if (global.DEBUG_MODE) {
        console.error('[cli] MCP server ready (passive mode)');
    }
}
// --- CLI setup ---
const program = new commander_1.Command();
program
    .version('Version ' + VERSION)
    .name('supersurf')
    .description('MCP server for browser automation using the SuperSurf Chrome extension')
    .option('--debug [mode]', 'Enable debug mode (verbose logging, reload tool). Use --debug=no_truncate for full payloads.')
    .option('--log-file <path>', 'Custom log file path')
    .option('--port <number>', 'WebSocket server port (default: 5555)', parseInt)
    .option('--child', 'Internal: child process spawned by wrapper')
    .option('--script-mode', 'JSON-RPC over stdio for automation scripts')
    .option('--disable-secure-eval', 'Disable secure_eval RCE protection on browser_evaluate (not recommended — equivalent to SUPERSURF_DISABLE_SECURE_EVAL=1)')
    .action(async (options) => {
    if (options.scriptMode) {
        (0, dotenv_1.loadDotenv)(process.cwd());
        const configService = buildConfig(options);
        const config = backendConfigFrom(configService);
        await (0, stdio_1.startScriptMode)(config);
        return;
    }
    if (options.debug && !options.child) {
        runAsWrapper();
        return;
    }
    if (options.child) {
        // Child inherits debug mode — wrapper always enables debug
        options.debug = options.debug || true;
    }
    await main(options);
});
program.parse(process.argv);
//# sourceMappingURL=cli.js.map