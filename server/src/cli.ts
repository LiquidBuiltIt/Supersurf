#!/usr/bin/env node
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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Command } from 'commander';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';

import { ConnectionManager, BackendConfig } from './backend';
import { getLogger, getRegistry, type DebugMode } from './logger';
import { startScriptMode } from './stdio';

const { version: VERSION } = require('../package.json');

/** Parse --debug value into a DebugMode. */
function parseDebugMode(value: unknown): DebugMode {
  if (value === 'no_truncate') return 'no_truncate';
  if (value) return 'truncate';
  return false;
}

/** Build a BackendConfig from CLI options and environment variables. */
function resolveConfig(options: any): BackendConfig {
  const envExperiments = process.env.SUPERSURF_EXPERIMENTS;
  const enabledExperiments = envExperiments
    ? envExperiments.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  return {
    debug: !!options.debug,
    port: options.port || 5555,
    server: {
      name: 'SuperSurf',
      version: VERSION,
    },
    enabledExperiments,
  };
}

/**
 * Debug wrapper mode. Spawns the server as a child process and monitors its exit code.
 * Exit code 42 triggers a restart (hot reload); any other code terminates the wrapper.
 * stdin/stdout are piped through PassThrough streams so the MCP client sees a
 * single continuous connection across reloads.
 */
function runAsWrapper(): void {
  console.error('[Wrapper] Starting in wrapper mode with auto-reload enabled');

  const inputBuffer = new PassThrough();
  const outputBuffer = new PassThrough();

  process.stdin.pipe(inputBuffer);
  outputBuffer.pipe(process.stdout);

  function spawnChild(): void {
    console.error('[Wrapper] Starting MCP server...');

    // Strip --debug from child args (wrapper already set debug context) and add --child flag
    const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--debug'));
    args.push('--child');

    const child = spawn(process.execPath, [__filename, ...args], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    inputBuffer.pipe(child.stdin!);
    child.stdout!.pipe(outputBuffer, { end: false });

    child.on('exit', (code, signal) => {
      console.error(`[Wrapper] Child exited (code=${code}, signal=${signal})`);

      inputBuffer.unpipe(child.stdin!);
      child.stdout!.unpipe(outputBuffer);

      if (code === 42) {
        console.error('[Wrapper] Reload requested, restarting...');
        setTimeout(() => spawnChild(), 100);
      } else {
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

/** Registers signal/close handlers with a 5s forced-exit timeout to prevent hangs. */
function setupExitWatchdog(): void {
  let cleanupDone = false;

  const cleanup = (): void => {
    if (cleanupDone) return;
    cleanupDone = true;

    if ((global as any).DEBUG_MODE) {
      console.error('[cli] Cleanup initiated');
    }

    setTimeout(() => {
      if ((global as any).DEBUG_MODE) {
        console.error('[cli] Forcing exit after timeout');
      }
      process.exit(0);
    }, 5000);
  };

  process.stdin.on('close', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

/** Boot the MCP server: init logging, create ConnectionManager, wire MCP handlers, start stdio transport. */
async function main(options: any): Promise<void> {
  setupExitWatchdog();

  const debugMode = parseDebugMode(options.debug);
  (global as any).DEBUG_MODE = !!debugMode;

  const reg = getRegistry();
  reg.debugMode = debugMode;

  const logger = getLogger(options.logFile);
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

  const config = resolveConfig(options);
  const backend = new ConnectionManager(config);

  if ((global as any).DEBUG_MODE) {
    console.error(`[cli] Creating MCP Server v${VERSION}...`);
  }

  const server = new Server(
    { name: config.server.name, version: config.server.version },
    { capabilities: { tools: {}, logging: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await backend.listTools();
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await backend.callTool(name, args ?? {});
  });

  await backend.initialize(server, {});

  if ((global as any).DEBUG_MODE) {
    console.error('[cli] Starting stdio transport...');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if ((global as any).DEBUG_MODE) {
    console.error('[cli] MCP server ready (passive mode)');
  }

  process.on('SIGINT', async () => {
    if ((global as any).DEBUG_MODE) {
      console.error('[cli] Shutting down...');
    }
    await backend.serverClosed();
    await server.close();
    process.exit(0);
  });
}

// --- CLI setup ---

const program = new Command();

program
  .version('Version ' + VERSION)
  .name('supersurf')
  .description('MCP server for browser automation using the SuperSurf Chrome extension')
  .option('--debug [mode]', 'Enable debug mode (verbose logging, reload tool). Use --debug=no_truncate for full payloads.')
  .option('--log-file <path>', 'Custom log file path')
  .option('--port <number>', 'WebSocket server port (default: 5555)', parseInt)
  .option('--child', 'Internal: child process spawned by wrapper')
  .option('--script-mode', 'JSON-RPC over stdio for automation scripts')
  .action(async (options) => {
    if (options.scriptMode) {
      const config = resolveConfig(options);
      await startScriptMode(config);
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
