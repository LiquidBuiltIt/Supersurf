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
export {};
//# sourceMappingURL=cli.d.ts.map