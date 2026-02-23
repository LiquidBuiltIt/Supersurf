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
import { BackendConfig } from './backend';
/** Initialize script mode: create backend, wire up readline for JSON-RPC, register signal handlers. */
export declare function startScriptMode(config: BackendConfig): Promise<void>;
//# sourceMappingURL=stdio.d.ts.map