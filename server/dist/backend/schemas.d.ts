/**
 * Connection-level tool schema definitions.
 *
 * Defines MCP tool schemas for the four connection management tools (enable, disable,
 * status, experimental_features) and the debug-only reload tool. These are always
 * available regardless of connection state, unlike browser tools which require an
 * active extension connection.
 *
 * @module backend/schemas
 * @exports getConnectionToolSchemas - Returns schemas for connection lifecycle tools
 * @exports getDebugToolSchema - Returns the reload_mcp schema (debug mode only)
 */
import type { ToolSchema } from './types';
/** Return MCP tool schemas for enable, disable, status, and experimental_features. */
export declare function getConnectionToolSchemas(): ToolSchema[];
/** Return the reload_mcp tool schema. Only exposed when `--debug` is active. */
export declare function getDebugToolSchema(): ToolSchema;
//# sourceMappingURL=schemas.d.ts.map