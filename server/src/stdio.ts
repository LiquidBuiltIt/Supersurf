/**
 * Script Mode -- JSON-RPC 2.0 over stdin/stdout.
 *
 * A lightweight alternative to full MCP for automation scripts. Reads newline-delimited
 * JSON-RPC 2.0 requests from stdin, dispatches them through ConnectionManager with
 * `rawResult: true` (plain JSON, no MCP content wrappers), and writes responses to stdout.
 *
 * Supports batch requests (JSON arrays) per the JSON-RPC 2.0 spec.
 * Activated via `--script-mode` CLI flag.
 *
 * @module stdio
 * @exports startScriptMode
 */

import readline from 'readline';
import { ConnectionManager, BackendConfig } from './backend';

/** Initialize script mode: create backend, wire up readline for JSON-RPC, register signal handlers. */
export async function startScriptMode(config: BackendConfig): Promise<void> {
  const backend = new ConnectionManager(config);
  await backend.initialize(null, {});

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line: string) => {
    try {
      const trimmed = line.trim();
      if (!trimmed) return;

      const parsed = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        const results = await Promise.all(parsed.map((req) => handleRequest(req, backend)));
        console.log(JSON.stringify(results));
      } else {
        const result = await handleRequest(parsed, backend);
        console.log(JSON.stringify(result));
      }
    } catch (error: any) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${error.message}`,
        },
      };
      console.log(JSON.stringify(errorResponse));
    }
  });

  rl.on('close', async () => {
    await backend.serverClosed();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await backend.serverClosed();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await backend.serverClosed();
    process.exit(0);
  });
}

/**
 * Process a single JSON-RPC 2.0 request.
 * Validates protocol version and method, then delegates to ConnectionManager.callTool.
 * @returns JSON-RPC 2.0 response object with result or error
 */
async function handleRequest(
  request: { jsonrpc?: string; id?: any; method?: string; params?: any },
  backend: ConnectionManager
): Promise<any> {
  const { jsonrpc, id, method, params } = request;

  if (jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      id: id || null,
      error: { code: -32600, message: 'Invalid JSON-RPC version (must be "2.0")' },
    };
  }

  if (!method || typeof method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: id || null,
      error: { code: -32600, message: 'Missing or invalid method' },
    };
  }

  try {
    const result = await backend.callTool(method, params || {}, { rawResult: true });
    return { jsonrpc: '2.0', id, result };
  } catch (error: any) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error.message || String(error) },
    };
  }
}
