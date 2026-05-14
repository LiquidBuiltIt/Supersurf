/**
 * Connection-level tool schema definitions.
 *
 * Defines MCP tool schemas for the three connection management tools (connect, disconnect,
 * status) and the debug-only reload tool. These are always available regardless of
 * connection state, unlike browser tools which require an active extension connection.
 *
 * Experiments are configured via `~/.supersurf/config.json` (auto-scaffolded on first
 * daemon start) and require a daemon restart to take effect.
 *
 * @module backend/schemas
 * @exports getConnectionToolSchemas - Returns schemas for connection lifecycle tools
 * @exports getDebugToolSchema - Returns the reload_mcp schema (debug mode only)
 */
import type { ToolSchema } from './types';
/** Return MCP tool schemas for connect, disconnect, and status. */
export declare function getConnectionToolSchemas(): ToolSchema[];
/** Return MCP tool schemas for profile management (create, list, delete). */
export declare function getProfileToolSchemas(): ToolSchema[];
/** Return the reload_mcp tool schema. Only exposed when `--debug` is active. */
export declare function getDebugToolSchema(): ToolSchema;
//# sourceMappingURL=schemas.d.ts.map