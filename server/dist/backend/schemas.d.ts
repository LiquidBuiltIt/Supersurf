/**
 * Connection-level tool schema definitions.
 *
 * Defines MCP tool schemas for the four connection management tools (connect, disconnect,
 * status, experimental_features) and the debug-only reload tool. These are always
 * available regardless of connection state, unlike browser tools which require an
 * active extension connection.
 *
 * @module backend/schemas
 * @exports getConnectionToolSchemas - Returns schemas for connection lifecycle tools
 * @exports getDebugToolSchema - Returns the reload_mcp schema (debug mode only)
 */
import type { ToolSchema } from './types';
/** Return MCP tool schemas for connect, disconnect, status, and experimental_features. */
export declare function getConnectionToolSchemas(): ToolSchema[];
/** Return MCP tool schemas for profile management (create, list, delete). */
export declare function getProfileToolSchemas(): ToolSchema[];
/** Return the reload_mcp tool schema. Only exposed when `--debug` is active. */
export declare function getDebugToolSchema(): ToolSchema;
//# sourceMappingURL=schemas.d.ts.map